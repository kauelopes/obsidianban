# Sprint Wizard — Lista Editável de Tarefas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transformar a etapa `tasks` do wizard de sprint-planning de uma tabela markdown somente-leitura numa lista editável (título, corpo, tipo, prioridade, tags — adicionar/remover/editar), mantendo a caixa de "corrigir" (regeneração via LLM) disponível ao lado.

**Architecture:** Novo tipo de tela `task_list` (contrato LLM → `structure.tasks` como já existe hoje; o servidor deriva `screen_payload.tasks` do `structure.tasks`, atribuindo ids sequenciais). Novo componente cliente `StepTaskList` (CRUD em memória, mesmo padrão do `StepList` já existente no wizard de projeto). Novo hook de captura no servidor (`SprintPlanningService.captureTasks`) que reconcilia a edição humana de volta em `session.outputs['tasks'].structure`, reaproveitando o validador `validateFinalSprint` já existente — nenhuma mudança em `materialize.ts`/`finalize()`, que já lê exatamente esse campo.

**Tech Stack:** TypeScript, React (sem framework de formulário), Vitest + Testing Library, MCP tools sobre HTTP.

## Global Constraints

- Objetivo da sprint (`structure.goal`) continua string única — não vira lista (decisão confirmada com o usuário).
- Wizard de projeto (`packages/planning/*`, `PlanWizard.tsx`) e o tipo de tela `list`/`StepList` genérico não são tocados.
- `materialize.ts` não muda — já lê `session.outputs['tasks'].structure`, e essa é a única fonte de verdade após a edição.
- Confirmar fica bloqueado se a lista de tarefas ficar vazia ou algum título ficar em branco (decisão confirmada com o usuário).
- Sem reordenação por drag-and-drop — só adicionar/editar/remover, na ordem em que aparecem.
- Extensão `.js` obrigatória em todos os imports relativos (NodeNext module resolution) — siga o padrão de cada arquivo tocado.

---

## Task 1: Tipos compartilhados — tela `task_list`

**Files:**
- Modify: `packages/shared/src/index.ts:634` (união `PlanningScreenType`) e `packages/shared/src/index.ts:649-652` (novas interfaces, ao lado de `PlanningListItem`/`PlanningListPayload`)

**Interfaces:**
- Produces: `PlanningScreenType` passa a incluir `'task_list'`; novas interfaces `PlanningTaskItem { id: string; title: string; type: 'task' | 'feature' | 'bug' | 'chore'; body?: string; priority?: 'low' | 'medium' | 'high' | 'critical'; tags?: string[] }` e `PlanningTaskListPayload { intro?: string; tasks: PlanningTaskItem[] }` — consumidas pelas Tasks 2, 5 e 6.

- [ ] **Step 1: Adicionar o literal `'task_list'` à união `PlanningScreenType`**

Em `packages/shared/src/index.ts:634`, troque:

```ts
export type PlanningScreenType = 'form' | 'choice' | 'list' | 'diagram' | 'confirm'
```

por:

```ts
export type PlanningScreenType = 'form' | 'choice' | 'list' | 'diagram' | 'confirm' | 'task_list'
```

- [ ] **Step 2: Adicionar as novas interfaces de payload**

Logo após a linha `export interface PlanningListPayload { intro?: string; items: PlanningListItem[] }` (`packages/shared/src/index.ts:650`), adicione:

```ts
export interface PlanningTaskItem {
  id: string
  title: string
  type: 'task' | 'feature' | 'bug' | 'chore'
  body?: string
  priority?: 'low' | 'medium' | 'high' | 'critical'
  tags?: string[]
}
export interface PlanningTaskListPayload {
  intro?: string
  tasks: PlanningTaskItem[]
}
```

- [ ] **Step 3: Rodar o typecheck do pacote shared**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/types run typecheck`
Expected: PASS (o pacote `shared` é só tipos — sem testes de runtime; a checagem real de uso vem nas Tasks seguintes).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): tipo de tela task_list para o wizard de sprint-planning"
```

---

## Task 2: Contrato do LLM e parser da etapa `tasks` (servidor)

**Files:**
- Modify: `packages/server/src/sprint-planning/steps.ts`
- Test: `packages/server/tests/unit/sprint-planning-steps.test.ts` (novo)

**Interfaces:**
- Consumes: nada de tasks anteriores (é só o contrato do LLM — os tipos do shared não são usados aqui, `structure` continua `unknown` na assinatura pública).
- Produces: `SprintStepDef` da etapa `'tasks'` passa a ter `screen: 'task_list'`. `parseOutput` dessa etapa (função `parseTaskList`) devolve `{ screen_payload: { intro?, tasks: Array<{id,title,type,body?,priority?,tags?}> }, structure: FinalSprint }` — o `structure` já validado por `validateFinalSprint`. Consumido pela Task 3 (`captureTasks` lê `session.outputs['tasks'].structure`) e pela Task 5 (cliente renderiza `screen_payload.tasks`).

- [ ] **Step 1: Escrever o teste que falha**

Crie `packages/server/tests/unit/sprint-planning-steps.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sprintStepById } from '../../src/sprint-planning/steps.js'

describe('etapa tasks — parseOutput (parseTaskList)', () => {
  it('deriva screen_payload.tasks com ids sequenciais a partir de structure.tasks', () => {
    const def = sprintStepById('tasks')!
    const raw = {
      screen_payload: { intro: 'contexto' },
      structure: {
        name: 'Sprint X',
        goal: 'entregar y',
        tasks: [
          { title: 'Uma', type: 'task' },
          { title: 'Duas', type: 'bug', priority: 'high', tags: ['x'] },
        ],
      },
    }
    const out = def.parseOutput(raw)
    expect(out.screen_payload).toEqual({
      intro: 'contexto',
      tasks: [
        { id: 't-0', title: 'Uma', type: 'task' },
        { id: 't-1', title: 'Duas', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
    expect(out.structure).toEqual({
      name: 'Sprint X',
      goal: 'entregar y',
      tasks: [
        { title: 'Uma', type: 'task' },
        { title: 'Duas', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
  })

  it('rejeita quando structure está ausente', () => {
    const def = sprintStepById('tasks')!
    expect(() => def.parseOutput({ screen_payload: {} })).toThrow('structure ausente')
  })

  it('rejeita structure inválida (tasks vazio)', () => {
    const def = sprintStepById('tasks')!
    expect(() =>
      def.parseOutput({
        screen_payload: {},
        structure: { name: 'x', goal: 'y', tasks: [] },
      }),
    ).toThrow(/structure inválida/)
  })

  it('a etapa tasks usa a tela task_list', () => {
    expect(sprintStepById('tasks')!.screen).toBe('task_list')
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp exec vitest run tests/unit/sprint-planning-steps.test.ts`
Expected: FAIL — `sprintStepById('tasks')!.screen` ainda é `'confirm'`, e `parseTaskList` não existe.

- [ ] **Step 3: Implementar `parseTaskList` e trocar a tela da etapa `tasks`**

Em `packages/server/src/sprint-planning/steps.ts`:

1. Atualize o comentário e a união de tipos (linhas 3-4):

```ts
/** Este wizard usa 4 dos 5 tipos de tela do wizard de projeto — sem diagram. */
export type SprintScreenType = 'form' | 'choice' | 'confirm' | 'task_list'
```

2. Adicione o import do validador logo abaixo do import existente (linha 1):

```ts
import type { SprintPlanningSession, SprintStepId } from './session.js'
import type { FinalSprint } from './structure-schema.js'
import { validateFinalSprint } from './structure-schema.js'
```

3. Adicione o novo contrato de payload, ao lado de `CONFIRM_CONTRACT` (linha 28):

```ts
const CONFIRM_CONTRACT = '{"screen_payload":{"markdown":"..."}'
const TASK_LIST_CONTRACT =
  '{"screen_payload":{"intro":"...(opcional, breve texto de contexto, nada de markdown/tabela)"}'
```

4. Atualize `contract()` (linhas 30-37) para incluir o novo tipo no mapa:

```ts
function contract(screen: SprintScreenType, withStructure = false): string {
  const base = {
    form: FORM_CONTRACT,
    choice: CHOICE_CONTRACT,
    confirm: CONFIRM_CONTRACT,
    task_list: TASK_LIST_CONTRACT,
  }[screen]
  const structurePart = withStructure ? ',"structure":{...conforme descrito acima...}' : ''
  return (
    `Responda SOMENTE com um objeto JSON válido, sem cerca de código e sem prosa fora dele, ` +
    `neste formato: ${base}${structurePart}}.`
  )
}
```

5. Adicione `parseTaskList` logo após `parseConfirm` (depois da linha 115):

```ts
function parseTaskList(raw: unknown): SprintStepOutput {
  const { payload, out } = parseCommon(raw)
  if (out.structure === undefined) throw new Error('structure ausente')
  let structure: FinalSprint
  try {
    structure = validateFinalSprint(out.structure)
  } catch (err) {
    throw new Error(`structure inválida: ${(err as Error).message}`)
  }
  const intro = typeof payload['intro'] === 'string' ? payload['intro'] : undefined
  const tasks = structure.tasks.map((t, i) => ({ id: `t-${i}`, ...t }))
  return { screen_payload: { ...(intro ? { intro } : {}), tasks }, structure }
}
```

6. Atualize o mapa `PARSERS` (linhas 117-121):

```ts
const PARSERS: Record<'form' | 'choice' | 'confirm' | 'task_list', (raw: unknown) => SprintStepOutput> = {
  form: parseForm,
  choice: parseChoice,
  confirm: parseConfirm,
  task_list: parseTaskList,
}
```

7. Atualize a assinatura de `step()` (linha 129):

```ts
function step(
  id: SprintStepId,
  title: string,
  screen: 'form' | 'choice' | 'confirm' | 'task_list',
  task: string,
  opts: { withStructure?: boolean } = {},
): SprintStepDef {
```

8. Troque a definição da etapa `tasks` (linhas 156-164) por:

```ts
step(
  'tasks',
  'Quebra em tarefas',
  'task_list',
  `Proponha o nome e o objetivo (goal) desta sprint e a quebra em tarefas executáveis por agentes de IA, dimensionada à capacidade confirmada. O usuário vai revisar e editar a lista diretamente (título, tipo, prioridade, corpo, tags) antes de confirmar — não monte markdown/tabela, só o campo "structure" com EXATAMENTE esta forma:
{"name":"<nome curto da sprint>","goal":"<frase-objetivo da sprint>","tasks":[{"title":"...","type":"task|feature|bug|chore","body":"# Spec\\n<o que fazer, critérios de aceite>","priority":"low|medium|high|critical","tags":["..."]}]}
Cada task.body é a Spec que um agente dev vai executar sem mais contexto — seja específico. 3 a 8 tarefas. Em "screen_payload", inclua opcionalmente um "intro" com uma frase de contexto.`,
  { withStructure: true },
),
```

- [ ] **Step 4: Rodar o teste e confirmar que passa**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp exec vitest run tests/unit/sprint-planning-steps.test.ts`
Expected: PASS (4 testes).

- [ ] **Step 5: Rodar o typecheck do servidor**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/server/src/sprint-planning/steps.ts packages/server/tests/unit/sprint-planning-steps.test.ts
git commit -m "feat(server): etapa tasks do wizard de sprint-planning usa a tela task_list"
```

---

## Task 3: Captura da edição humana (`captureTasks`)

**Files:**
- Modify: `packages/server/src/services/sprint-planning.ts`
- Modify: `packages/server/tests/service/sprint-planning.test.ts` (atualiza um teste existente + adiciona um describe novo)

**Interfaces:**
- Consumes: `validateFinalSprint` de `../sprint-planning/structure-schema.js` (já importado em `sprint-planning.ts:25`); `badRequest`/`conflict` de `./errors.js` (já importados em `sprint-planning.ts:29`); `session.outputs['tasks'].structure` produzido pela Task 2.
- Produces: `SprintPlanningService.answer()` passa a rejeitar (400) uma edição de tarefas inválida sem avançar a etapa, e a sobrescrever `session.outputs['tasks'].structure` com a edição válida — consumido por `finalize()` (já existente, sem mudança) e pela Task 5/6 (o array `{tasks}` que o cliente envia).

- [ ] **Step 1: Atualizar o teste de fluxo existente que envia `{approved: true}` para a etapa `tasks`**

Em `packages/server/tests/service/sprint-planning.test.ts`, dentro de `describe('fluxo completo até review', ...)`, no primeiro `it` (`'goal com épico existente seta epic_id; tasks emite structure; review habilita finalize'`), troque este trecho (por volta da linha 202-205):

```ts
    runner.pushScreen(FORM_PAYLOAD)
    await service.answer({ session_id: s.session_id, step: 'tasks', answer: { approved: true } }, mgr)
    settled = await settle(s.session_id)
    expect(settled.current_step).toBe('risks')
```

por:

```ts
    runner.pushScreen(FORM_PAYLOAD)
    await service.answer(
      { session_id: s.session_id, step: 'tasks', answer: { tasks: [{ title: 'Tarefa 1 editada', type: 'task' }] } },
      mgr,
    )
    settled = await settle(s.session_id)
    expect(settled.current_step).toBe('risks')
    expect(settled.outputs['tasks']?.structure).toEqual({
      name: TASKS_STRUCTURE.name,
      goal: TASKS_STRUCTURE.goal,
      tasks: [{ title: 'Tarefa 1 editada', type: 'task' }],
    })
```

- [ ] **Step 2: Adicionar o describe de testes novos para `captureTasks`**

Ainda em `packages/server/tests/service/sprint-planning.test.ts`, adicione um novo bloco `describe` (por exemplo logo antes de `describe('finalize', ...)`):

```ts
describe('captureTasks (edição humana da etapa tasks)', () => {
  async function reachTasksStep(): Promise<string> {
    await setupTestProject(paths, 'test-project')
    runner.pushScreen(FORM_PAYLOAD)
    const s = await service.start({ project: 'test-project' }, mgr)
    await settle(s.session_id)
    runner.pushScreen(CHOICE_PAYLOAD)
    await service.answer({ session_id: s.session_id, step: 'capacity', answer: { capacity: '3' } }, mgr)
    await settle(s.session_id)
    runner.pushScreen({}, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { choice: 'adhoc' } }, mgr)
    await settle(s.session_id)
    return s.session_id
  }

  it('edição válida sobrescreve structure.tasks preservando name/goal', async () => {
    const sessionId = await reachTasksStep()
    const settled = await service.answer(
      {
        session_id: sessionId,
        step: 'tasks',
        answer: { tasks: [{ title: 'Nova tarefa', type: 'feature', priority: 'high' }] },
      },
      mgr,
    )
    expect(settled.outputs['tasks']?.structure).toEqual({
      name: TASKS_STRUCTURE.name,
      goal: TASKS_STRUCTURE.goal,
      tasks: [{ title: 'Nova tarefa', type: 'feature', priority: 'high' }],
    })
  })

  it('lista vazia é rejeitada com 400 e não avança a etapa', async () => {
    const sessionId = await reachTasksStep()
    await expect(
      service.answer({ session_id: sessionId, step: 'tasks', answer: { tasks: [] } }, mgr),
    ).rejects.toMatchObject({ status: 400 })
    const after = await service.get({ session_id: sessionId }, mgr)
    expect(after.current_step).toBe('tasks')
  })

  it('type inválido é rejeitado com 400', async () => {
    const sessionId = await reachTasksStep()
    await expect(
      service.answer(
        { session_id: sessionId, step: 'tasks', answer: { tasks: [{ title: 'x', type: 'invalido' }] } },
        mgr,
      ),
    ).rejects.toMatchObject({ status: 400 })
  })
})
```

- [ ] **Step 3: Rodar os testes e confirmar que falham**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp exec vitest run tests/service/sprint-planning.test.ts`
Expected: FAIL — `answer()` ainda faz passthrough cego; a edição de tarefas não sobrescreve `structure`, e `{tasks: []}` não é rejeitado com 400.

- [ ] **Step 4: Implementar `captureTasks` e o branch em `answer()`**

Em `packages/server/src/services/sprint-planning.ts`, no método `answer()` (linhas 111-112), troque:

```ts
    session.answers[session.current_step] = answer
    if (session.current_step === 'goal') this.captureGoal(session, answer)
```

por:

```ts
    session.answers[session.current_step] = answer
    if (session.current_step === 'goal') this.captureGoal(session, answer)
    if (session.current_step === 'tasks') this.captureTasks(session, answer)
```

Logo após o método `captureGoal` (depois da linha 358), adicione:

```ts
  /**
   * Reconcilia a edição humana da lista de tarefas de volta em
   * outputs['tasks'].structure — sem isso, finalize() só materializaria a
   * proposta original do LLM, nunca a edição do usuário. name/goal não fazem
   * parte desta tela e ficam intocados.
   */
  private captureTasks(session: SprintPlanningSession, answer: unknown): void {
    const existing = session.outputs['tasks']?.structure as { name: string; goal: string } | undefined
    if (!existing) throw conflict({ reason: 'structure_missing', hint: 'complete a etapa tasks antes' })
    if (typeof answer !== 'object' || answer === null) {
      throw badRequest('invalid_field', { field: 'tasks' })
    }
    const tasksRaw = (answer as Record<string, unknown>)['tasks']
    let structure
    try {
      structure = validateFinalSprint({ name: existing.name, goal: existing.goal, tasks: tasksRaw })
    } catch (err) {
      throw badRequest('invalid_field', { field: 'tasks', detail: (err as Error).message })
    }
    session.outputs['tasks'] = { ...session.outputs['tasks']!, structure }
  }
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp exec vitest run tests/service/sprint-planning.test.ts`
Expected: PASS (todos os testes do arquivo, incluindo os 3 novos de `captureTasks` e o fluxo atualizado).

- [ ] **Step 6: Rodar o typecheck do servidor**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/services/sprint-planning.ts packages/server/tests/service/sprint-planning.test.ts
git commit -m "feat(server): captureTasks reconcilia a edição humana da etapa tasks"
```

---

## Task 4: Modo stub (`PLANNING_STUB`) — tela `task_list`

**Files:**
- Modify: `packages/server/src/sprint-planning/stub-runner.ts`

**Interfaces:**
- Consumes: nenhuma nova — só o `SprintScreenType` já ampliado na Task 2.
- Produces: nenhuma — é só garantir que o modo de desenvolvimento continua funcional para a etapa `tasks` depois da troca de tela.

- [ ] **Step 1: Adicionar o caso `task_list` em `payloadFor`**

Em `packages/server/src/sprint-planning/stub-runner.ts`, no método `payloadFor` (switch por `def.screen`), adicione um caso antes do fechamento do switch:

```ts
  private payloadFor(def: SprintStepDef): unknown {
    switch (def.screen) {
      case 'form':
        return {
          fields: [{ id: 'campo_a', label: `${def.title} — campo A`, help: 'stub', value: 'valor pré-preenchido A' }],
        }
      case 'choice':
        return {
          question: `${def.title}: qual opção? (stub)`,
          options: [
            { id: 'adhoc', label: 'Objetivo novo, sem épico', description: 'opção sintética' },
            { id: 'opcao-2', label: 'Opção 2', description: 'segunda opção sintética' },
          ],
          suggested: 'adhoc',
        }
      case 'confirm':
        return {
          markdown: `## ${def.title} (stub)\n\nTexto sintético para a tela de confirmação.\n\n- ponto um\n- ponto dois`,
        }
      case 'task_list':
        return { intro: `${def.title} (stub) — contexto sintético` }
    }
  }
```

(Só a linha `case 'task_list':` e o `return` seguinte são novos — as demais permanecem como já estão no arquivo.)

- [ ] **Step 2: Verificar manualmente o modo stub end-to-end**

Run: `PLANNING_STUB=true ~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev` (em um terminal), e em outro, com um token pm de teste, percorra o wizard de sprint-planning até a etapa `tasks` — confirme que a lista aparece com as 2 tarefas sintéticas (`buildResponse`/`structureFor` do stub-runner, inalterado) renderizadas como itens editáveis, não como tabela markdown.
Expected: a etapa `tasks` mostra a lista editável com as tarefas "Tarefa um"/"Tarefa dois" do stub.

- [ ] **Step 3: Rodar a suíte completa do servidor**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run test`
Expected: PASS (todos os testes, incluindo os das Tasks 2 e 3).

- [ ] **Step 4: Commit**

```bash
git add packages/server/src/sprint-planning/stub-runner.ts
git commit -m "feat(server): stub runner cobre a tela task_list da etapa tasks"
```

---

## Task 5: Componente cliente `StepTaskList`

**Files:**
- Modify: `packages/web/src/plan/screens.tsx` (novo componente `StepTaskList`; `RefineBox` deixa de ser privada)
- Modify: `packages/web/src/styles/detail.css` (nova classe `.wizard-task-item`)
- Test: `packages/web/tests/sprint-plan-task-list.test.tsx` (novo)

**Interfaces:**
- Consumes: `PlanningTaskItem`/`PlanningTaskListPayload` de `@obsidiankan/types` (Task 1); `RefineBox` (já existe em `screens.tsx`, só passa a ser exportada).
- Produces: `StepTaskList({ payload: PlanningTaskListPayload, busy: boolean, onSubmit: (answer: { tasks: Array<Omit<PlanningTaskItem, 'id'>> }) => void, onRefine: (feedback: string) => void })` — consumido pela Task 6 (`SprintPlanWizard.tsx`).

- [ ] **Step 1: Escrever o teste que falha**

Crie `packages/web/tests/sprint-plan-task-list.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { StepTaskList } from '../src/plan/screens.js'

describe('StepTaskList', () => {
  const basePayload = {
    tasks: [
      { id: 't-0', title: 'Tarefa 1', type: 'task' as const, priority: 'medium' as const },
      { id: 't-1', title: 'Tarefa 2', type: 'bug' as const, priority: 'high' as const, tags: ['x'] },
    ],
  }

  it('edita título, remove uma tarefa e envia o array sem os ids sintéticos', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)

    fireEvent.change(screen.getAllByLabelText('título da tarefa')[0]!, {
      target: { value: 'Tarefa 1 editada' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'remover Tarefa 2' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }))

    expect(onSubmit).toHaveBeenCalledWith({
      tasks: [{ title: 'Tarefa 1 editada', type: 'task', priority: 'medium' }],
    })
  })

  it('adicionar tarefa insere uma linha em branco (type task, priority medium)', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ adicionar tarefa' }))
    expect(screen.getAllByLabelText('título da tarefa')).toHaveLength(3)
  })

  it('confirmar fica desabilitado com título vazio ou lista vazia', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '+ adicionar tarefa' }))
    expect(screen.getByRole('button', { name: 'Confirmar e continuar' })).toBeDisabled()
  })

  it('edita tipo e prioridade via selects', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    const typeSelects = screen.getAllByLabelText('Tipo')
    const prioritySelects = screen.getAllByLabelText('Prioridade')
    fireEvent.change(typeSelects[0]!, { target: { value: 'bug' } })
    fireEvent.change(prioritySelects[0]!, { target: { value: 'critical' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({
      tasks: [
        { title: 'Tarefa 1', type: 'bug', priority: 'critical' },
        { title: 'Tarefa 2', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
  })

  it('adiciona uma tag a uma tarefa', () => {
    const onSubmit = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={onSubmit} onRefine={vi.fn()} />)
    const tagInputs = screen.getAllByPlaceholderText('nova tag + Enter')
    fireEvent.change(tagInputs[0]!, { target: { value: 'nova' } })
    fireEvent.keyDown(tagInputs[0]!, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({
      tasks: [
        { title: 'Tarefa 1', type: 'task', priority: 'medium', tags: ['nova'] },
        { title: 'Tarefa 2', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
  })

  it('renderiza a caixa de correção e chama onRefine', () => {
    const onRefine = vi.fn()
    render(<StepTaskList payload={basePayload} busy={false} onSubmit={vi.fn()} onRefine={onRefine} />)
    fireEvent.change(screen.getByLabelText('pedir correção'), { target: { value: 'tarefas muito vagas' } })
    fireEvent.click(screen.getByRole('button', { name: 'corrigir' }))
    expect(onRefine).toHaveBeenCalledWith('tarefas muito vagas')
  })
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web exec vitest run tests/sprint-plan-task-list.test.tsx`
Expected: FAIL — `StepTaskList` não existe em `../src/plan/screens.js`.

- [ ] **Step 3: Exportar `RefineBox` e implementar `StepTaskList`**

Em `packages/web/src/plan/screens.tsx`:

1. Atualize o import do topo do arquivo (linhas 2-9) para incluir os novos tipos:

```ts
import type {
  PlanningChoicePayload,
  PlanningConfirmPayload,
  PlanningDiagramPayload,
  PlanningFormPayload,
  PlanningListItem,
  PlanningListPayload,
  PlanningTaskItem,
  PlanningTaskListPayload,
} from '@obsidiankan/types'
```

2. Torne `RefineBox` exportada — troque (linha 169):

```ts
function RefineBox({
```

por:

```ts
export function RefineBox({
```

3. Adicione, após `StepList` (depois da linha 166, antes de `RefineBox`), o novo componente:

```tsx
const TASK_TYPES = ['task', 'feature', 'bug', 'chore'] as const
const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const

export function StepTaskList({
  payload,
  busy,
  onSubmit,
  onRefine,
}: {
  payload: PlanningTaskListPayload
  busy: boolean
  onSubmit: (answer: { tasks: Array<Omit<PlanningTaskItem, 'id'>> }) => void
  onRefine: (feedback: string) => void
}) {
  const [tasks, setTasks] = useState<PlanningTaskItem[]>(payload.tasks)
  const patch = (i: number, p: Partial<PlanningTaskItem>) =>
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, ...p } : t)))
  const addTag = (i: number, tag: string) =>
    setTasks((prev) =>
      prev.map((t, j) =>
        j === i && !(t.tags ?? []).includes(tag) ? { ...t, tags: [...(t.tags ?? []), tag] } : t,
      ),
    )
  const removeTag = (i: number, tag: string) =>
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, tags: (t.tags ?? []).filter((x) => x !== tag) } : t)))

  return (
    <div className="form">
      {payload.intro && <p>{payload.intro}</p>}
      {tasks.map((t, i) => (
        <div key={t.id} className="wizard-task-item">
          <input
            aria-label="título da tarefa"
            value={t.title}
            onChange={(e) => patch(i, { title: e.target.value })}
          />
          <div className="form-row">
            <label>
              <span>Tipo</span>
              <select value={t.type} onChange={(e) => patch(i, { type: e.target.value as PlanningTaskItem['type'] })}>
                {TASK_TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {tp}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Prioridade</span>
              <select
                value={t.priority ?? 'medium'}
                onChange={(e) => patch(i, { priority: e.target.value as PlanningTaskItem['priority'] })}
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            aria-label="corpo da tarefa"
            rows={3}
            value={t.body ?? ''}
            onChange={(e) => patch(i, { body: e.target.value })}
          />
          <div className="chips">
            {(t.tags ?? []).map((tag) => (
              <span className="chip" key={tag}>
                #{tag}
                <button type="button" onClick={() => removeTag(i, tag)}>
                  ×
                </button>
              </span>
            ))}
            <TagInput onAdd={(tag) => addTag(i, tag)} />
          </div>
          <button
            className="danger"
            aria-label={`remover ${t.title}`}
            onClick={() => setTasks((prev) => prev.filter((_, j) => j !== i))}
          >
            remover
          </button>
        </div>
      ))}
      <div className="form-row">
        <button
          onClick={() =>
            setTasks((prev) => [
              ...prev,
              { id: `nova-${prev.length + 1}`, title: '', type: 'task', priority: 'medium' },
            ])
          }
        >
          + adicionar tarefa
        </button>
        <div className="spacer" />
      </div>
      <RefineBox
        busy={busy}
        onRefine={onRefine}
        placeholder="algo errado nas tarefas sugeridas? descreva e eu regenero"
      />
      <div className="form-row wizard-cta">
        <div className="spacer" />
        <button
          className="primary"
          disabled={busy || tasks.length === 0 || tasks.some((t) => !t.title.trim())}
          onClick={() => onSubmit({ tasks: tasks.map(({ id: _id, ...rest }) => rest) })}
        >
          Confirmar e continuar
        </button>
      </div>
    </div>
  )
}

function TagInput({ onAdd }: { onAdd: (tag: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <input
      value={value}
      placeholder="nova tag + Enter"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const t = value.trim().replace(/^#/, '')
          if (t) {
            onAdd(t)
            setValue('')
          }
        }
      }}
    />
  )
}
```

- [ ] **Step 4: Adicionar a classe `.wizard-task-item`**

Em `packages/web/src/styles/detail.css`, logo após o bloco `.wizard-list-item textarea` (linhas 1661-1663), adicione:

```css
.wizard-task-item {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  border: 1px solid var(--line, currentColor);
  border-radius: var(--r-2, 6px);
  margin-bottom: var(--s-3);
}

.wizard-task-item .form-row {
  gap: var(--s-3);
}
```

- [ ] **Step 5: Rodar o teste e confirmar que passa**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web exec vitest run tests/sprint-plan-task-list.test.tsx`
Expected: PASS (6 testes).

- [ ] **Step 6: Rodar o typecheck do web**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/plan/screens.tsx packages/web/src/styles/detail.css packages/web/tests/sprint-plan-task-list.test.tsx
git commit -m "feat(web): StepTaskList — lista editável de tarefas sugeridas"
```

---

## Task 6: Ligar `task_list` no wizard de sprint-planning (cliente)

**Files:**
- Modify: `packages/web/src/sprint-plan/steps-meta.ts:18`
- Modify: `packages/web/src/sprint-plan/SprintPlanWizard.tsx`

**Interfaces:**
- Consumes: `StepTaskList` e `PlanningTaskListPayload` (Task 5); `SprintStepMeta.screen` já tipado como `PlanningScreenType` (Task 1).
- Produces: nenhuma nova — é a ponta final da integração; a etapa `tasks` do wizard de sprint-planning passa a renderizar `StepTaskList` em vez de `StepConfirm`.

- [ ] **Step 1: Atualizar os metadados da etapa `tasks`**

Em `packages/web/src/sprint-plan/steps-meta.ts:18`, troque:

```ts
  { id: 'tasks', title: 'Tarefas', screen: 'confirm' },
```

por:

```ts
  { id: 'tasks', title: 'Tarefas', screen: 'task_list' },
```

- [ ] **Step 2: Adicionar o caso `task_list` no dispatcher de tela**

Em `packages/web/src/sprint-plan/SprintPlanWizard.tsx`:

1. Atualize o import de tipos (linhas 3-9) e de componentes (linha 15):

```ts
import type {
  PlanningChoicePayload,
  PlanningConfirmPayload,
  PlanningFormPayload,
  PlanningTaskListPayload,
  SprintPlanningFinalizeResult,
  SprintPlanningSessionView,
} from '@obsidiankan/types'
```

```ts
import { StepChoice, StepConfirm, StepForm, StepTaskList } from '../plan/screens.js'
```

2. Na função `StepScreen` (linhas 234-249), adicione o novo caso antes do `default`:

```ts
  switch (screen) {
    case 'form':
      return <StepForm payload={payload as PlanningFormPayload} busy={busy} onSubmit={onSubmit} />
    case 'choice':
      return <StepChoice payload={payload as PlanningChoicePayload} busy={busy} onSubmit={onSubmit} />
    case 'task_list':
      return (
        <StepTaskList
          payload={payload as PlanningTaskListPayload}
          busy={busy}
          onSubmit={onSubmit}
          onRefine={onRefine}
        />
      )
    default:
      return (
        <StepConfirm
          payload={payload as PlanningConfirmPayload}
          busy={busy}
          confirmLabel={isReview ? 'Aprovar sprint' : 'Confirmar e continuar'}
          onSubmit={onSubmit}
          onRefine={onRefine}
        />
      )
  }
```

- [ ] **Step 3: Rodar o typecheck do web**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web run typecheck`
Expected: PASS.

- [ ] **Step 4: Rodar a suíte completa do web**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web run test`
Expected: PASS (nenhum teste existente de `plan.test.tsx` toca o wizard de sprint-planning, então nada deveria quebrar).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/sprint-plan/steps-meta.ts packages/web/src/sprint-plan/SprintPlanWizard.tsx
git commit -m "feat(web): liga StepTaskList na etapa tasks do wizard de sprint-planning"
```

---

## Task 7: Verificação final e build do SPA

**Files:** nenhum arquivo novo — só verificação.

**Interfaces:** nenhuma.

- [ ] **Step 1: Typecheck do monorepo inteiro**

Run: `~/.local/share/pnpm/bin/pnpm run typecheck`
Expected: PASS em `shared`, `server` e `web`.

- [ ] **Step 2: Suíte de testes do monorepo inteiro**

Run: `~/.local/share/pnpm/bin/pnpm run test`
Expected: PASS — todos os testes de `server` e `web`, incluindo os 4 arquivos novos/alterados desta feature.

- [ ] **Step 3: Build do servidor e do SPA**

Run: `~/.local/share/pnpm/bin/pnpm run build && ~/.local/share/pnpm/bin/pnpm run build:web`
Expected: ambos concluem sem erro.

- [ ] **Step 4: Verificação manual em modo stub**

Run: `PLANNING_STUB=true ~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev` e percorrer o wizard "Criar sprint com assistente" de um projeto de teste até a etapa "Tarefas": editar o título de uma tarefa, mudar tipo/prioridade, adicionar uma tag, remover uma tarefa, adicionar uma nova tarefa, confirmar. Depois seguir até "Revisão" e materializar — conferir no board que os cards criados refletem a edição (não a sugestão original do stub).
Expected: os cards criados no board têm os títulos/tipos/prioridades editados na etapa, não os valores sintéticos originais.

- [ ] **Step 5: Commit final (se sobrar algo, ex.: ajuste de docs)**

```bash
git status
```

Se não houver mudanças pendentes, não há o que commitar — as Tasks 1-6 já cobriram tudo.
