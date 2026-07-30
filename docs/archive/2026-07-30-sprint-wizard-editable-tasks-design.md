# Wizard de sprint-planning — lista editável de tarefas sugeridas (design)

## Problema

A etapa `tasks` do wizard de sprint-planning (`packages/server/src/sprint-planning/steps.ts:156-164`) usa hoje o tipo de tela `confirm`: o LLM produz `structure.tasks` (o array real usado na materialização) e um `screen_payload.markdown` — uma tabela **somente leitura** renderizada por `StepConfirm` (`packages/web/src/plan/screens.tsx:231-261`). O usuário não pode editar título/corpo/tipo/prioridade de uma tarefa, apagar uma sugestão ruim, nem adicionar uma nova — a única ferramenta é pedir "correção" em texto livre pela `RefineBox`, que dispara um turno inteiro novo do LLM.

Investigação mais profunda revelou uma segunda lacuna: **nenhuma etapa do wizard hoje reconcilia a resposta humana de volta em `session.outputs[step].structure`.** `SprintPlanningService.answer()` (`packages/server/src/services/sprint-planning.ts:100-122`) faz um passthrough cego (`session.answers[step] = answer`) exceto por um hook bespoke para a etapa `goal` (`captureGoal`). A materialização (`finalize()`, linhas 157-166) sempre lê `outputs['tasks'].structure`, que só o LLM escreve. Para a edição humana ter efeito real, é preciso um hook equivalente para a etapa `tasks`.

## Objetivo

Tornar a lista de tarefas sugeridas editável: renomear/editar corpo, tipo e prioridade de cada tarefa, remover uma tarefa, adicionar uma nova — tudo antes de confirmar a etapa. A caixa de "corrigir" (regenerar via LLM) continua disponível ao lado, para quando o problema é de fundo, não só de texto. Objetivo da sprint (`structure.goal`) continua sendo uma frase única — fora de escopo, confirmado com o usuário.

## Novo tipo de tela: `task_list`

Tela dedicada — não reaproveita o tipo `list` genérico do wizard de projeto (`PlanningListItem { title, detail? }`), porque o formato de item aqui é mais rico e específico de tarefa.

```ts
// packages/shared/src/index.ts
interface PlanningTaskItem {
  id: string // atribuído pelo servidor ("t-0", "t-1"...), só para key/edição no cliente — não é o id do card final
  title: string
  type: 'task' | 'feature' | 'bug' | 'chore'
  body?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  tags?: string[]
}
interface PlanningTaskListPayload {
  intro?: string
  tasks: PlanningTaskItem[]
}
```

`PlanningScreenType` (shared) ganha o literal `'task_list'`.

### Contrato do LLM

O LLM continua produzindo `structure = {name, goal, tasks}` exatamente como hoje (mesmo formato, mesma validação por `validateFinalSprint`). O que muda é o `screen_payload`: em vez de pedir uma tabela markdown separada, o servidor deriva `screen_payload.tasks` diretamente de `structure.tasks`, atribuindo um `id` sequencial a cada item (`parseTaskList` em `packages/server/src/sprint-planning/steps.ts`, substituindo o atual `parseConfirm` só para esta etapa). Isso elimina uma fonte de divergência (markdown vs. array) e simplifica o prompt.

## Componente cliente: `StepTaskList`

Novo componente em `packages/web/src/plan/screens.tsx`, ao lado de `StepList`, seguindo o mesmo padrão de estado local + edição em memória:

- Por tarefa: `<input>` de título, `<select>` de tipo (task/feature/bug/chore), `<select>` de prioridade (low/medium/high/critical, default `medium`), `<textarea>` de corpo (opcional), editor de tags em chips (mesmo padrão do `TagsField` em `packages/web/src/card/FrontmatterForm.tsx:212-256`: chip com `×` + input/Enter para adicionar, dedup).
- Botão "remover" por linha (sem confirmação nativa — mesmo padrão do `StepList`, é uma edição pré-confirmação, nada foi persistido ainda).
- Botão "+ adicionar tarefa" — acrescenta linha em branco (`type: 'task'`, `priority: 'medium'`, título vazio).
- `RefineBox` (hoje privada em `screens.tsx:169-199`) passa a ser exportada e renderizada abaixo da lista — convive sem conflito com a edição direta, porque usa um endpoint totalmente independente (`refine()` regenera `outputs[step]` via LLM; `answer()` grava a edição direta — nenhum dos dois toca no estado do outro a não ser por reescrever o mesmo campo final).

**Validação de submit:** botão de confirmar desabilitado enquanto (a) algum título estiver vazio, ou (b) a lista estiver vazia — decisão do usuário: uma sprint sem nenhuma tarefa não pode ser confirmada por este wizard (o board sempre permite adicionar cards manualmente depois, se for esse o caso raro).

Ao confirmar, `onSubmit({ tasks })` envia o array editado completo (sem os `id`s sintéticos, que são só de UI) — mesmo padrão de "não é diff, é o estado final completo" que `StepList` já usa hoje.

## Captura no servidor

`packages/server/src/services/sprint-planning.ts`, `SprintPlanningService.answer()`: novo branch, paralelo ao `captureGoal` existente:

```ts
if (session.current_step === 'tasks') this.captureTasks(session, answer)
```

`captureTasks(session, answer)`:
1. Lê `existing = session.outputs['tasks'].structure` (já validado pelo LLM na etapa anterior).
2. Reconstrói `{ name: existing.name, goal: existing.goal, tasks: answer['tasks'] }` — `name`/`goal` não fazem parte desta tela e ficam intocados.
3. Valida com `validateFinalSprint` (já exportada em `packages/server/src/planning/structure-schema.ts:79-81`, reaproveitada tal como é — já rejeita array vazio com `"tasks: deve ser um array não-vazio"` e valida `type`/`priority`/`tags` item a item). Erro de validação vira `badRequest('invalid_field', ...)` (400), igual ao padrão de erro já usado no resto do serviço.
4. Se válido, sobrescreve `session.outputs['tasks'].structure` com o resultado validado.

Como `finalize()` já lê exatamente `outputs['tasks'].structure` (`sprint-planning.ts:157-166`), nenhuma mudança é necessária em `materialize.ts` — a edição humana passa a ser a fonte de verdade automaticamente.

## Registro do novo tipo de tela (checklist de arquivos)

| Camada | Arquivo | Mudança |
|---|---|---|
| Tipos compartilhados | `packages/shared/src/index.ts` | `PlanningScreenType` ganha `'task_list'`; novas interfaces `PlanningTaskItem`/`PlanningTaskListPayload` |
| Contrato do LLM | `packages/server/src/sprint-planning/steps.ts` | `SprintScreenType` união; novo `TASK_LIST_CONTRACT`; `contract()` ganha o caso; novo `parseTaskList`; `PARSERS` map; etapa `tasks` passa `screen: 'task_list'` |
| Validação/materialização | `packages/server/src/planning/structure-schema.ts` | Nenhuma mudança — `validateFinalSprint` já serve tal como é |
| Captura da resposta humana | `packages/server/src/services/sprint-planning.ts` | Novo método `captureTasks`; novo branch em `answer()` |
| Metadados da etapa (cliente) | `packages/web/src/sprint-plan/steps-meta.ts` | Etapa `tasks` passa `screen: 'task_list'` |
| Dispatcher de tela (cliente) | `packages/web/src/sprint-plan/SprintPlanWizard.tsx` | `StepScreen`: novo `case 'task_list'` |
| Componente de tela (cliente) | `packages/web/src/plan/screens.tsx` | Novo `StepTaskList`; `RefineBox` passa a ser exportada |

## Fora de escopo

- Objetivo da sprint (`structure.goal`) continua string única — não vira lista.
- Wizard de projeto (`packages/planning/*`, `PlanWizard.tsx`) e o tipo de tela `list`/`StepList` genérico não são tocados.
- Materializador (`materialize.ts`) não muda — já lê o campo certo.
- Não adiciona reordenação de tarefas por drag-and-drop — só adicionar/editar/remover, na ordem em que aparecem.

## Testes

- Servidor: teste de `SprintPlanningService.answer()` para a etapa `tasks` — edição válida sobrescreve `structure`; edição com título vazio ou lista vazia retorna 400 e não avança a etapa; `name`/`goal` originais do LLM são preservados após a edição.
- Servidor: `parseTaskList` — deriva `screen_payload.tasks` com `id`s sequenciais a partir de `structure.tasks`.
- Cliente: `StepTaskList` — adicionar linha, remover linha, editar campos, botão de confirmar desabilitado com título vazio ou lista vazia, submit envia o array completo sem os `id`s sintéticos.
