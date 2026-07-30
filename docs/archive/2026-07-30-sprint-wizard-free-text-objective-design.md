# Wizard de sprint-planning — objetivo em texto livre (design)

## Problema

O wizard de sprint-planning (`packages/server/src/sprint-planning/steps.ts`) tem hoje 5 etapas: `capacity` → `goal` → `tasks` → `risks` → `review`. Duas delas não fazem o que o nome sugere:

- `capacity`: pede ao usuário confirmar quantas tarefas cabem na sprint, com a LLM pré-preenchendo uma sugestão baseada na velocidade média das últimas 3 sprints fechadas (`SprintPlanningService.buildContext`, `services/sprint-planning.ts:324-350`).
- `goal` ("Objetivo da sprint"): **não captura um objetivo em texto** — é uma tela `choice` onde o usuário escolhe a qual épico existente a sprint se conecta (ou `"adhoc"`, sem épico). O texto-objetivo real (`structure.goal`, uma frase) é inventado pela LLM dentro da etapa seguinte, `tasks`, junto com os cards, e nunca é exposto para o usuário escrever ou editar diretamente.

Isso significa que o único "input" de intenção do usuário para o que a sprint deve conter é a escolha de um épico — a LLM decide sozinha o objetivo e os cards a partir do contexto do projeto, sem o usuário poder descrever o que quer.

## Objetivo

1. Remover a etapa `capacity` — sem teto de tarefas nem sugestão baseada em velocidade histórica; a LLM decide livremente quantos cards propor, dimensionando pela ambição do objetivo descrito.
2. Transformar `goal` em uma caixa de texto livre onde o usuário descreve o que quer fazer na sprint — substituindo completamente a escolha de épico (a sprint deixa de se vincular automaticamente a um épico por este wizard; isso pode ser feito manualmente no board depois, se necessário).
3. Esse texto passa a ser o input principal que a LLM usa, na etapa `tasks`, para gerar a proposta de nome + objetivo + cards da sprint — que já é editável pelo usuário antes de confirmar (via `StepTaskList`, feature já existente).

## Sequência nova

`goal` (texto livre, sem chamada de LLM) → `tasks` (LLM, gera nome/objetivo/cards a partir do texto) → `risks` (form informativo, LLM pré-preenche riscos) → `review` (confirm, resumo final).

## Etapa `goal` deixa de disparar turno de LLM

Toda etapa do wizard hoje é implementada como um turno de LLM (`SprintStepDef.buildPrompt` + `parseOutput`, despachado via `dispatchTurn`/`executeTurn` em `services/sprint-planning.ts`) — inclusive `capacity`, cuja única função era montar um `form` com um campo pré-preenchido.

A etapa `goal` passa a ser a primeira exceção: não precisa de LLM para montar uma caixa de texto vazia. `SprintPlanningService.start()` monta diretamente o `screen_payload` estático:

```json
{"fields":[{"id":"objective","label":"Objetivo da sprint","help":"Descreva o que você quer entregar nesta sprint"}]}
```

e a sessão já nasce em `status: 'awaiting_user'`, `current_step: 'goal'`, sem chamar `this.runner.runTurn`. Isso reaproveita a tela `form` existente (`StepForm`, `packages/web/src/plan/screens.tsx:21-55`) sem componente novo no cliente, e evita gastar um turno de LLM (e a latência de um `claude -p`) só para desenhar um textarea.

`SprintStepDef` ganha uma forma de marcar uma etapa como "sem LLM" (ex.: um campo opcional `llm: false`, ou a etapa `goal` é tratada como caso especial fora do array `SPRINT_STEPS` — detalhe de implementação a decidir no plano). O importante do contrato: `answer()` para `goal` grava a resposta em `session.answers.goal` e avança para `tasks` sem nenhum tratamento especial de captura (diferente do `captureGoal` atual, que interpretava a escolha como `epic_id` — esse método é removido).

## Como o texto chega até a LLM

Nenhuma plumbing nova: `contextBlock()` (`sprint-planning/steps.ts:52-67`) já serializa `session.answers` inteiro em todo prompt de turno subsequente (`Estado atual (respostas do usuário por etapa)`). O texto do campo `objective` já estará lá quando a etapa `tasks` rodar. O que muda é o prompt da etapa `tasks` (`sprint-planning/steps.ts:180-187`): a instrução deixa de mencionar "capacidade confirmada" e passa a instruir a LLM a seguir fielmente o objetivo descrito pelo usuário na etapa anterior, decidindo livremente a quantidade de tarefas (mantém a faixa "3 a 8 tarefas" como guia de granularidade, não como limite rígido).

`INTRO` (`sprint-planning/steps.ts:48-50`) atualiza a frase que descreve o processo: "objetivo (why) → quebra em tarefas (what/how) → riscos → revisão" (remove "capacidade →" do início).

## Remoção do vínculo com épico

- `SprintPlanningSession.epic_id` (`sprint-planning/session.ts:39`) é removido.
- `SprintPlanningService.captureGoal` é removido (não há mais o que capturar nessa etapa além do texto bruto).
- `materialize.ts` (`sprint-planning/materialize.ts:63-79`) remove o bloco que linka a sprint criada ao épico via `session.epic_id`, incluindo o checkpoint `epic_linked` em `SprintMaterializationCheckpoint`.
- `SprintPlanningContext.project_epics` (lista de épicos do projeto, usada hoje para montar as opções do `choice`) deixa de ser necessária para este fluxo e é removida de `buildContext()` — a listagem de épicos (`this.epics.listEpics`) não é mais chamada por este serviço.

## Remoção da capacidade

- `SprintStepId` perde o literal `'capacity'`.
- `SprintPlanningContext.suggested_capacity` é removido.
- `SprintPlanningService.buildContext()` para de consultar sprints fechadas e calcular a média de velocidade (`sprint-planning.ts:328-342`, incluindo a constante `VELOCITY_SAMPLE`).
- A etapa `step('capacity', ...)` é removida de `SPRINT_STEPS`.

## Cliente

- `packages/web/src/sprint-plan/steps-meta.ts`: remove a entrada `capacity`; a etapa `goal` passa a ter título "Objetivo" (mantendo o mesmo `screen: 'form'`).
- `packages/web/src/sprint-plan/SprintPlanWizard.tsx`: nenhuma mudança de dispatcher — `case 'form'` já existe e cobre a nova etapa `goal` sem alteração.
- Nenhum componente novo: `StepForm` já renderiza um textarea a partir de `fields[].id/label/help`, que é exatamente o formato do payload estático da etapa `goal`.

## Fora de escopo

- A etapa `tasks` continua com `StepTaskList` (lista editável de cards) — nenhuma mudança de UI ali, só o prompt que a alimenta.
- Nenhuma mudança nas etapas `risks` e `review`.
- Nenhuma migração de dados para sessões de wizard já em andamento no formato antigo (etapa `capacity` ou `goal`-como-choice): como é um wizard de sessão curta (minutos), sessões ativas nesse estado no momento do deploy ficam órfãs — aceitável, sem tratamento especial.
- Vínculo de sprint a épico continua possível manualmente pelo board — só não é mais feito por este wizard.

## Testes

- Server: `SprintPlanningService.start()` — sessão nasce em `awaiting_user` na etapa `goal` com o payload estático de texto livre; nenhuma chamada a `runner.runTurn` acontece nesse passo.
- Server: `answer()` na etapa `goal` — texto vazio retorna 400 e não avança; texto válido grava em `session.answers.goal` e dispara o turno da etapa `tasks`, cujo prompt inclui o texto do objetivo (via `contextBlock`).
- Server: `buildContext()` não consulta mais `listEpics` nem sprints fechadas por velocidade.
- Server: `materialize.ts` — sprint materializada nunca tenta linkar `epic_id` (campo removido).
- Cliente: `steps-meta.ts` sem entrada `capacity`; wizard renderiza a etapa `goal` como formulário de texto livre e valida campo vazio antes de habilitar avançar.
