# Wizard de sprint-planning — objetivo em texto livre Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remover a etapa `capacity` do wizard de sprint-planning e trocar a etapa `goal` (hoje uma escolha de épico) por uma caixa de texto livre onde o usuário descreve o objetivo da sprint, que passa a alimentar a LLM na geração dos cards.

**Architecture:** A sequência do wizard vira `goal` (texto livre, sem turno de LLM) → `tasks` (LLM, gera nome/objetivo/cards a partir do texto) → `risks` → `review`. `goal` é a primeira etapa do wizard a não disparar turno de LLM: `SprintStepDef` ganha um campo `llm: boolean` e um `staticOutput()`; `SprintPlanningService.start()` monta o payload estático diretamente quando a primeira etapa não usa LLM. O texto do objetivo chega à LLM automaticamente via `contextBlock()`, que já serializa `session.answers` em todo prompt — nenhuma plumbing nova para isso. Vínculo com épico (`epic_id`) e sugestão de capacidade por velocidade são removidos por completo (spec: substituição total, sem migração).

**Tech Stack:** TypeScript, Node.js (`node:http` cru), Vitest, React + Testing Library, pnpm workspaces.

## Global Constraints

- Gerenciador de pacotes: `~/.local/share/pnpm/bin/pnpm` (não está no PATH em shells não-interativos).
- Build order: shared → server (`pnpm run build` já respeita isso via `tsc --build` com project references).
- Sem comentários óbvios — só o "porquê" não óbvio, como o resto do arquivo já faz.
- Sem fallback/validação para cenários impossíveis (ex.: sem migração de sessões antigas — spec explícita).
- Sem novo componente web: a etapa `goal` reaproveita `StepForm`/tela `form` já existentes.

---

### Task 1: Tipos compartilhados (`@obsidiankan/types`)

**Files:**
- Modify: `packages/shared/src/index.ts:680, 756-791`

**Interfaces:**
- Produces: `PlanningScreenType` sem `'choice'` para o consumo do wizard de sprint (tipo continua com `'choice'` porque o wizard de projeto/KAD ainda usa — **não remover o literal do union**, só parar de emiti-lo neste wizard); `SprintStepId = 'goal' | 'tasks' | 'risks' | 'review'`; `SprintPlanningContextView = { target_repo: string | null }`; `SprintPlanningSessionView` sem `epic_id`; `SprintPlanningFinalizeResult` sem `epic_linked`.

- [ ] **Step 1: Editar `SprintStepId`, `SprintPlanningContextView`, `SprintPlanningSessionView`, `SprintPlanningFinalizeResult`**

Em `packages/shared/src/index.ts`, substituir o bloco (linhas 756-791):

```ts
export type SprintStepId = 'goal' | 'tasks' | 'risks' | 'review'

export interface SprintPlanningContextView {
  target_repo: string | null
}

/**
 * Visão da sessão do wizard de sprint devolvida pelas tools
 * kanban_sprint_planning_*. Menor que PlanningSessionView: sem `kad`, com
 * `project`/`context` (o wizard já nasce escopado a um projeto existente).
 */
export interface SprintPlanningSessionView {
  session_id: string
  project: string
  status: PlanningStatus
  current_step: SprintStepId
  context: SprintPlanningContextView
  answers: Record<string, unknown>
  outputs: Record<string, PlanningStepOutput>
  usage: { input_tokens: number; output_tokens: number; usd: number; turns: number }
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface SprintPlanningFinalizeResult {
  session_id: string
  project: string
  sprint_id: string
  new_cards_created: number
  new_cards_failed: Array<{ index: number; error: string }>
}
```

(Nota: `PlanningScreenType` na linha 680 **não muda** — `'choice'` continua no union porque o wizard de projeto/KAD ainda o usa.)

- [ ] **Step 2: Build do pacote shared**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/types run build`
Expected: build sem erros (o pacote shared não tem consumidores nele mesmo que quebrem — os erros de tipo nos consumidores aparecem no Task 2 e são esperados até lá).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(types): sprint-planning perde epic_id/capacidade dos tipos compartilhados"
```

---

### Task 2: Servidor — sequência do wizard, materialização e serviço

**Files:**
- Modify: `packages/server/src/sprint-planning/session.ts`
- Modify: `packages/server/src/sprint-planning/steps.ts`
- Modify: `packages/server/src/sprint-planning/materialize.ts`
- Modify: `packages/server/src/sprint-planning/stub-materialize.ts`
- Modify: `packages/server/src/sprint-planning/stub-runner.ts`
- Modify: `packages/server/src/services/sprint-planning.ts`
- Modify: `packages/server/src/index.ts`

**Interfaces:**
- Consumes: tipos do Task 1 (`SprintStepId`, `SprintPlanningContextView` shape via `SprintPlanningContext` — mesmo shape, tipo interno).
- Produces: `SprintStepDef.llm: boolean` e `SprintStepDef.staticOutput?(session): SprintStepOutput`; `SPRINT_STEPS[0]` é a etapa `goal` com `llm: false`; `SprintMaterializeResult` sem `epic_linked`; `SprintPlanningService` construtor sem o parâmetro `epics`.

- [ ] **Step 1: `session.ts` — remover `capacity`, `epic_id`, `suggested_capacity`, `project_epics`, `epic_linked`**

Em `packages/server/src/sprint-planning/session.ts`, substituir:

```ts
export type SprintStepId = 'capacity' | 'goal' | 'tasks' | 'risks' | 'review'

/** Contexto do projeto carregado uma única vez em start() — não refeito a cada turno. */
export interface SprintPlanningContext {
  project_epics: Array<{ id: string; name: string; objective: string | null }>
  suggested_capacity: { avg_cards_per_sprint: number; sample_sprints: number } | null
  target_repo: string | null
}

/** Checkpoint da materialização — cada fase concluída registra o que criou. */
export interface SprintMaterializationCheckpoint {
  sprint_created?: string
  epic_linked?: boolean
  new_cards?: number
}
```

por:

```ts
export type SprintStepId = 'goal' | 'tasks' | 'risks' | 'review'

/** Contexto do projeto carregado uma única vez em start() — não refeito a cada turno. */
export interface SprintPlanningContext {
  target_repo: string | null
}

/** Checkpoint da materialização — cada fase concluída registra o que criou. */
export interface SprintMaterializationCheckpoint {
  sprint_created?: string
  new_cards?: number
}
```

E, no `SprintPlanningSession`, remover a linha `epic_id: string | null` e o comentário acima dela (`/** Setado quando a etapa "goal" escolhe um épico existente; null = objetivo ad-hoc. */`).

Em `newSprintPlanningSession`, remover a linha `epic_id: null,`.

- [ ] **Step 2: `steps.ts` — reescrever por completo**

Substituir todo o conteúdo de `packages/server/src/sprint-planning/steps.ts` por:

```ts
import type { SprintPlanningSession, SprintStepId } from './session.js'
import type { FinalSprint } from './structure-schema.js'
import { validateFinalSprint } from './structure-schema.js'

/** Este wizard usa 3 dos tipos de tela do wizard de projeto — sem choice, sem diagram. */
export type SprintScreenType = 'form' | 'confirm' | 'task_list'

export interface SprintStepOutput {
  screen_payload: unknown
  /** Presente apenas na etapa "tasks" — validada por structure-schema (FinalSprint). */
  structure?: unknown
}

export interface SprintStepDef {
  id: SprintStepId
  title: string
  screen: SprintScreenType
  /** false só para "goal": tela estática, sem turno de LLM (ver staticOutput). */
  llm: boolean
  buildPrompt(session: SprintPlanningSession): string
  /** Valida o JSON do LLM; a mensagem do throw alimenta o retry corretivo. */
  parseOutput(raw: unknown): SprintStepOutput
  /** Só presente quando llm=false — payload pronto, sem turno. */
  staticOutput?(session: SprintPlanningSession): SprintStepOutput
}

// ── Contratos de payload por tipo de tela (mesma convenção do wizard de projeto,
// sem kad_patch — este wizard não produz documentos KAD) ────────────────────────

const FORM_CONTRACT =
  '{"screen_payload":{"fields":[{"id":"...","label":"...","help":"...(opcional)","value":"...(pré-preenchimento opcional)"}]}'
const CONFIRM_CONTRACT = '{"screen_payload":{"markdown":"..."}'
const TASK_LIST_CONTRACT =
  '{"screen_payload":{"intro":"...(opcional, breve texto de contexto, nada de markdown/tabela)"}'

function contract(screen: SprintScreenType, withStructure = false): string {
  const base = {
    form: FORM_CONTRACT,
    confirm: CONFIRM_CONTRACT,
    task_list: TASK_LIST_CONTRACT,
  }[screen]
  const structurePart = withStructure ? ',"structure":{...conforme descrito acima...}' : ''
  return (
    `Responda SOMENTE com um objeto JSON válido, sem cerca de código e sem prosa fora dele, ` +
    `neste formato: ${base}${structurePart}}.`
  )
}

const INTRO = `Você é o facilitador de Sprint Planning do ObsidianKan. O projeto já existe — junto com o usuário, você vai definir a quebra em tarefas de UMA sprint nova a partir do objetivo que ele descreveu, seguindo a prática de Sprint Planning (Scrum): objetivo (why, já escrito pelo usuário) → quebra em tarefas (what/how) → riscos → revisão.

O processo é um wizard: a cada turno eu te digo o contexto do projeto, o que o usuário respondeu, e qual a próxima etapa; você devolve APENAS JSON no contrato pedido — o texto vai direto para a interface, então capriche no conteúdo e seja específico à sprint (nada de genérico). Escreva em português brasileiro.`

function contextBlock(session: SprintPlanningSession): string {
  const parts = [`Projeto: ${session.project}`]
  // Re-enviado a cada turno: o --resume já carrega o contexto, mas repetir o
  // estado mantém o turno correto mesmo se a sessão do harness se perder. É
  // também aqui que o objetivo em texto livre da etapa "goal" chega à LLM.
  parts.push(`Estado atual (respostas do usuário por etapa):\n${JSON.stringify(session.answers, null, 2)}`)
  return parts.join('\n')
}

function turnPreamble(session: SprintPlanningSession): string {
  return session.claude_session_id === null ? `${INTRO}\n\n${contextBlock(session)}` : contextBlock(session)
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseCommon(raw: unknown): { payload: Record<string, unknown>; out: SprintStepOutput } {
  if (typeof raw !== 'object' || raw === null) throw new Error('resposta deve ser um objeto JSON')
  const r = raw as Record<string, unknown>
  const payload = r['screen_payload']
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('screen_payload ausente ou não é objeto')
  }
  const out: SprintStepOutput = { screen_payload: payload }
  if (r['structure'] !== undefined) out.structure = r['structure']
  return { payload: payload as Record<string, unknown>, out }
}

function parseForm(raw: unknown): SprintStepOutput {
  const { payload, out } = parseCommon(raw)
  const fields = payload['fields']
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('screen_payload.fields deve ser um array não-vazio')
  }
  for (const f of fields) {
    const o = f as Record<string, unknown>
    if (typeof o['id'] !== 'string' || typeof o['label'] !== 'string') {
      throw new Error('cada field precisa de id e label string')
    }
  }
  return out
}

function parseConfirm(raw: unknown): SprintStepOutput {
  const { payload, out } = parseCommon(raw)
  if (typeof payload['markdown'] !== 'string' || payload['markdown'].trim() === '') {
    throw new Error('screen_payload.markdown deve ser string não-vazia')
  }
  return out
}

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

const PARSERS: Record<SprintScreenType, (raw: unknown) => SprintStepOutput> = {
  form: parseForm,
  confirm: parseConfirm,
  task_list: parseTaskList,
}

// ── Etapa "goal": texto livre, sem turno de LLM ─────────────────────────────

function goalStaticOutput(): SprintStepOutput {
  return {
    screen_payload: {
      fields: [
        {
          id: 'objective',
          label: 'Objetivo da sprint',
          help: 'Descreva o que você quer entregar nesta sprint — a IA vai propor os cards a partir disso.',
        },
      ],
    },
  }
}

const GOAL_STEP: SprintStepDef = {
  id: 'goal',
  title: 'Objetivo',
  screen: 'form',
  llm: false,
  buildPrompt: () => {
    throw new Error('etapa "goal" não usa turno de LLM')
  },
  parseOutput: () => {
    throw new Error('etapa "goal" não usa turno de LLM')
  },
  staticOutput: goalStaticOutput,
}

// ── Sequência ────────────────────────────────────────────────────────────────
// objetivo (why, texto do usuário) → tarefas (what/how, emite structure) → riscos → revisão.

function step(
  id: SprintStepId,
  title: string,
  screen: 'form' | 'confirm' | 'task_list',
  task: string,
  opts: { withStructure?: boolean } = {},
): SprintStepDef {
  return {
    id,
    title,
    screen,
    llm: true,
    buildPrompt: (session) =>
      `${turnPreamble(session)}\n\nPróxima etapa: "${title}" (tela ${screen}).\n${task}\n\n${contract(screen, opts.withStructure ?? false)}`,
    parseOutput: PARSERS[screen],
  }
}

export const SPRINT_STEPS: SprintStepDef[] = [
  GOAL_STEP,
  step(
    'tasks',
    'Quebra em tarefas',
    'task_list',
    `O usuário descreveu o objetivo desta sprint na etapa anterior (campo "objective" em "Estado atual" acima). Proponha o nome e o objetivo (goal) desta sprint — fiel ao que o usuário descreveu — e a quebra em tarefas executáveis por agentes de IA. Você decide livremente quantas tarefas propor, dimensionando pela ambição do objetivo (3 a 8 é o normal, mas não é um teto rígido). O usuário vai revisar e editar a lista diretamente (título, tipo, prioridade, corpo, tags) antes de confirmar — não monte markdown/tabela, só o campo "structure" com EXATAMENTE esta forma:
{"name":"<nome curto da sprint>","goal":"<frase-objetivo da sprint>","tasks":[{"title":"...","type":"task|feature|bug|chore","body":"# Spec\\n<o que fazer, critérios de aceite>","priority":"low|medium|high|critical","tags":["..."]}]}
Cada task.body é a Spec que um agente dev vai executar sem mais contexto — seja específico. Em "screen_payload", inclua opcionalmente um "intro" com uma frase de contexto.`,
    { withStructure: true },
  ),
  step(
    'risks',
    'Riscos e dependências',
    'form',
    'Monte um form com um único campo "risks" pré-preenchido com os riscos e dependências identificáveis nas tarefas propostas (um por linha, com possível mitigação) — puramente informativo, para o usuário revisar antes de confirmar.',
  ),
  step(
    'review',
    'Revisão final',
    'confirm',
    'Apresente em markdown um resumo da sprint (objetivo, tarefas com tipo/prioridade, riscos) para aprovação final antes de criar a sprint no board.',
  ),
]

export const SPRINT_STEP_IDS: SprintStepId[] = SPRINT_STEPS.map((s) => s.id)

export function sprintStepById(id: string): SprintStepDef | null {
  return SPRINT_STEPS.find((s) => s.id === id) ?? null
}

export function nextSprintStep(id: SprintStepId): SprintStepDef | null {
  const idx = SPRINT_STEPS.findIndex((s) => s.id === id)
  return idx >= 0 && idx + 1 < SPRINT_STEPS.length ? SPRINT_STEPS[idx + 1]! : null
}

/** Prompt de refinamento: mesma etapa, feedback humano, mesmo contrato. */
export function buildSprintRefinePrompt(
  session: SprintPlanningSession,
  def: SprintStepDef,
  feedback: string,
): string {
  return (
    `${contextBlock(session)}\n\nO usuário pediu correção na etapa "${def.title}": ${feedback}\n` +
    `Reenvie a etapa corrigida por completo. ${contract(def.screen, def.id === 'tasks')}`
  )
}

/** Prompt corretivo quando o JSON anterior não validou. */
export function buildSprintRetryPrompt(def: SprintStepDef, validationError: string): string {
  return (
    `Sua resposta anterior não validou: ${validationError}. ` +
    `Reenvie APENAS o objeto JSON corrigido, completo. ${contract(def.screen, def.id === 'tasks')}`
  )
}
```

- [ ] **Step 3: `materialize.ts` — remover vínculo de épico**

Substituir todo o conteúdo de `packages/server/src/sprint-planning/materialize.ts` por:

```ts
import type { TokenClaims } from '@obsidiankan/types'
import { wizardActorTag } from '../planning/wizard-actor.js'
import type { SprintService } from '../services/sprint.js'
import type { CardService } from '../services/card.js'
import type { SprintPlanningSession } from './session.js'
import type { FinalSprint } from './structure-schema.js'

const BULK_BATCH = 100

export interface SprintMaterializeDeps {
  sprints: SprintService
  cards: CardService
  /** Rótulo do modelo que roda os turnos do wizard — vira o actor `<modelo>:sprint-wizard`. */
  modelLabel: string
  /** Persiste a sessão após cada fase — é o checkpoint da retomada. */
  saveSession(session: SprintPlanningSession): Promise<void>
}

export interface SprintMaterializeResult {
  project: string
  sprint_id: string
  new_cards_created: number
  new_cards_failed: Array<{ index: number; error: string }>
}

export type SprintMaterializer = (
  session: SprintPlanningSession,
  structure: FinalSprint,
  claims: TokenClaims,
) => Promise<SprintMaterializeResult>

/**
 * Materializa a sprint final no board: cria a sprint (em planning) e cria as
 * tarefas novas. Bem menor que o wizard de projeto — sem criação de
 * projeto/token, sem KAD. Mesmo padrão de checkpoint idempotente (retomável
 * após falha parcial).
 */
export function createSprintMaterializer(deps: SprintMaterializeDeps): SprintMaterializer {
  return async (session, structure, claims) => {
    const project = session.project
    const cp = (session.materialization ??= {})
    const save = () => deps.saveSession(session)
    // Quem decidiu objetivo e tarefas foi o modelo, não o humano que clicou em
    // "finalizar" — o actor gravado no CREATE reflete isso (mesma técnica do
    // wizard de projeto, com um sufixo próprio para diferenciar no audit log).
    const wizardActor = wizardActorTag(deps.modelLabel, 'sprint-wizard')
    const wizardClaims: TokenClaims = { ...claims, actor: wizardActor }

    // 1. Sprint (fica em planning — ativar é decisão humana posterior)
    if (!cp.sprint_created) {
      const created = await deps.sprints.createSprint(
        { project, name: structure.name, goal: structure.goal },
        wizardClaims,
      )
      cp.sprint_created = created.id
      await save()
    }
    const sprintId = cp.sprint_created!

    // 2. Tarefas novas, em lotes ≤100 — falha por card vira relatório
    let alreadyCreated = cp.new_cards ?? 0
    const failed: SprintMaterializeResult['new_cards_failed'] = []
    for (let i = alreadyCreated; i < structure.tasks.length; i += BULK_BATCH) {
      const batch = structure.tasks.slice(i, i + BULK_BATCH)
      const res = await deps.cards.bulkCreate(
        {
          project,
          sprint_id: sprintId,
          cards: batch.map((t) => ({
            title: t.title,
            type: t.type,
            ...(t.body ? { body: t.body } : {}),
            ...(t.priority ? { priority: t.priority } : {}),
            ...(t.tags ? { tags: t.tags } : {}),
          })),
          input_tokens: 0,
          output_tokens: 0,
        },
        wizardClaims,
      )
      alreadyCreated += res.created.length
      for (const f of res.failed) failed.push({ index: i + f.index, error: f.error })
      cp.new_cards = i + batch.length
      await save()
    }

    return {
      project,
      sprint_id: sprintId,
      new_cards_created: alreadyCreated,
      new_cards_failed: failed,
    }
  }
}
```

- [ ] **Step 4: `stub-materialize.ts` — remover `epic_linked`**

Substituir todo o conteúdo de `packages/server/src/sprint-planning/stub-materialize.ts` por:

```ts
import { logger } from '../util/logger.js'
import type { SprintMaterializer, SprintMaterializeResult } from './materialize.js'

/**
 * Modo de desenvolvimento (PLANNING_STUB=true): substitui a materialização real
 * por um resultado sintético — nenhuma sprint ou card é criado de verdade. Sem
 * isso, PLANNING_STUB só trocava os turnos do LLM; o botão "Materializar
 * sprint" ainda escrevia no vault/board reais.
 */
export function createStubSprintMaterializer(): SprintMaterializer {
  return async (session, structure): Promise<SprintMaterializeResult> => {
    logger.warn(
      { project: session.project, session_id: session.session_id },
      'sprint-planning: PLANNING_STUB ativo — materialização simulada, nada foi escrito',
    )
    return {
      project: session.project,
      sprint_id: `stub-${session.session_id}`,
      new_cards_created: structure.tasks.length,
      new_cards_failed: [],
    }
  }
}
```

- [ ] **Step 5: `stub-runner.ts` — remover o caso `choice`**

Em `packages/server/src/sprint-planning/stub-runner.ts`, no método `payloadFor`, remover o `case 'choice':` inteiro (as 6 linhas entre `case 'form':` e `case 'confirm':`), ficando:

```ts
  private payloadFor(def: SprintStepDef): unknown {
    switch (def.screen) {
      case 'form':
        return {
          fields: [{ id: 'campo_a', label: `${def.title} — campo A`, help: 'stub', value: 'valor pré-preenchido A' }],
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

- [ ] **Step 6: `services/sprint-planning.ts` — construtor, `start()`, `answer()`, `buildContext()`**

Remover a linha de import `import type { EpicService } from './epic.js'`.

Remover a constante `const VELOCITY_SAMPLE = 3` e seu comentário acima (`/** Quantas sprints fechadas recentes entram na média de velocidade sugerida. */`).

No construtor, remover o parâmetro `epics`:

```ts
  constructor(
    private readonly paths: Paths,
    private readonly store: SprintPlanningSessionStore,
    private readonly runner: TurnRunner,
    private readonly repo: CardRepository,
    private readonly sse: SSEEventBus,
    private readonly modelLabel: string,
    private readonly sprints: SprintService,
    private readonly materializer: SprintMaterializer,
  ) {}
```

Em `start()`, substituir:

```ts
    const context = await this.buildContext(project, claims)
    const first = SPRINT_STEPS[0]!
    const session = newSprintPlanningSession(project, context, first.id)
    return this.dispatchTurn(session, first, first.buildPrompt(session), claims)
```

por:

```ts
    const context = await this.buildContext(project)
    const first = SPRINT_STEPS[0]!
    const session = newSprintPlanningSession(project, context, first.id)
    if (!first.llm) {
      session.outputs[first.id] = first.staticOutput!(session)
      session.status = 'awaiting_user'
      await this.store.save(session)
      return session
    }
    return this.dispatchTurn(session, first, first.buildPrompt(session), claims)
```

Em `answer()`, remover a linha `if (session.current_step === 'goal') this.captureGoal(session, answer)`, mantendo só:

```ts
    session.answers[session.current_step] = answer
    if (session.current_step === 'tasks') this.captureTasks(session, answer)
```

Substituir o método `buildContext` inteiro (que hoje consulta épicos e velocidade de sprints fechadas) por:

```ts
  private async buildContext(project: string): Promise<SprintPlanningContext> {
    const meta = await loadProjectMetaOrNull(this.paths, project)
    return { target_repo: meta?.target_repo ?? null }
  }
```

Remover o método `captureGoal` inteiro (incluindo seu comentário JSDoc, se houver).

- [ ] **Step 7: `index.ts` — atualizar a montagem do `SprintPlanningService`**

Em `packages/server/src/index.ts`, no bloco de construção de `sprintPlanning` (linhas 163-181), remover `epics,` da chamada de `new SprintPlanningService(...)` e remover `epics,` do objeto passado a `createSprintMaterializer({...})`:

```ts
  const sprintPlanning = new SprintPlanningService(
    config.paths,
    sprintPlanningStore,
    sprintPlanningRunner,
    repo,
    sse,
    planningModelLabel,
    sprints,
    planningStub
      ? createStubSprintMaterializer()
      : createSprintMaterializer({
          sprints,
          cards,
          modelLabel: planningModelLabel,
          saveSession: (s) => sprintPlanningStore.save(s),
        }),
  )
```

(A constante `epics` continua declarada e usada pelos handlers `kanban_create_epic`/`kanban_list_epics`/`kanban_update_epic` — não remover a declaração, só estas duas passagens.)

- [ ] **Step 8: Build e typecheck do servidor**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run typecheck && ~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run build`
Expected: sem erros. Se aparecer erro em `tests/service/sprint-planning.test.ts` ou `tests/service/sprint-materialize.test.ts`, ignore por ora — `tsc --noEmit` do servidor só cobre `src/**/*.ts` (ver `include` do tsconfig), então erros nesses arquivos não devem aparecer aqui; se aparecerem, é sinal de que algo no `src/` ainda referencia o formato antigo — revisar antes de seguir.

- [ ] **Step 9: Commit**

```bash
git add packages/server/src/sprint-planning packages/server/src/services/sprint-planning.ts packages/server/src/index.ts
git commit -m "feat(server): sprint wizard sem etapa capacity; goal vira texto livre sem turno de LLM"
```

---

### Task 3: Catálogo de tools MCP

**Files:**
- Modify: `packages/server/src/server/tool-catalog.ts:79-86`
- Generate: `docs/for-agents/tool-catalog.md` (via script, não editar à mão)

**Interfaces:**
- Consumes: nenhuma nova — só texto de descrição.

- [ ] **Step 1: Atualizar descrições em `tool-catalog.ts`**

Em `packages/server/src/server/tool-catalog.ts`, trocar as três descrições abaixo (mantendo `name`/`access`/`category` intactos):

`kanban_sprint_planning_start`:
```ts
  { name: 'kanban_sprint_planning_start', access: 'pm', category: 'Planejamento', description: 'Start a new sprint-planning wizard session for an existing project (requires `project`). Only one active session per project — 409 sprint_planning_session_active otherwise. Returns the session already awaiting the first step (goal — free-text objective, answered without an LLM turn).' },
```

`kanban_sprint_planning_answer`:
```ts
  { name: 'kanban_sprint_planning_answer', access: 'pm', category: 'Planejamento', description: 'Submit the human answer for the current step and advance the wizard. Every step past "goal" is LLM-generated, so answering usually returns immediately with status "generating" — the result arrives via SSE/polling. Answering "goal" itself returns synchronously (no LLM turn on that step).' },
```

`kanban_sprint_planning_finalize`:
```ts
  { name: 'kanban_sprint_planning_finalize', access: 'pm', category: 'Planejamento', description: 'Materialize an approved sprint plan: creates the sprint (in planning state) and bulk-creates the new tasks. Synchronous and checkpointed: if it fails midway, calling it again resumes without duplicating.' },
```

- [ ] **Step 2: Regenerar o catálogo em markdown**

Run: `~/.local/share/pnpm/bin/pnpm run gen:tools`
Expected: `docs/for-agents/tool-catalog.md` atualizado (diff só nas 3 linhas de `kanban_sprint_planning_*` editadas).

- [ ] **Step 3: Commit**

```bash
git add packages/server/src/server/tool-catalog.ts docs/for-agents/tool-catalog.md
git commit -m "docs(tools): atualiza descrições do sprint wizard sem capacidade/vínculo de épico"
```

---

### Task 4: Reescrever `tests/service/sprint-planning.test.ts`

**Files:**
- Modify: `packages/server/tests/service/sprint-planning.test.ts`

**Interfaces:**
- Consumes: `SprintPlanningService` (construtor sem `epics`, Task 2), `SPRINT_STEPS`/`SprintStepDef` de `sprint-planning/steps.js`.

- [ ] **Step 1: Reescrever o arquivo por completo**

Substituir todo o conteúdo de `packages/server/tests/service/sprint-planning.test.ts` por:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SprintPlanningService } from '../../src/services/sprint-planning.js'
import { SprintPlanningSessionStore } from '../../src/sprint-planning/session.js'
import type { TurnResult, TurnRunner } from '../../src/planning/claude-runner.js'
import { SprintService } from '../../src/services/sprint.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeAgentClaims } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { SSEEvent } from '@obsidiankan/types'

/** Runner fake: fila de respostas, um TurnResult por turno (mesmo padrão de planning.test.ts). */
class FakeRunner implements TurnRunner {
  queue: TurnResult[] = []
  prompts: string[] = []
  cancelled = false

  push(partial: Partial<TurnResult> & { text?: string }): void {
    this.queue.push({
      ok: true,
      text: '',
      sessionId: 'claude-sess-1',
      usage: { input: 100, output: 50, usd: 0.01 },
      rateLimited: false,
      error: null,
      ...partial,
    })
  }

  pushScreen(payload: unknown, extra: Record<string, unknown> = {}): void {
    this.push({ text: JSON.stringify({ screen_payload: payload, ...extra }) })
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    this.prompts.push(prompt)
    const next = this.queue.shift()
    if (!next) throw new Error('FakeRunner: fila vazia')
    return next
  }

  cancel(): void {
    this.cancelled = true
  }
}

let paths: Paths
let store: SprintPlanningSessionStore
let runner: FakeRunner
let repo: CardRepository
let sprints: SprintService
let sse: SSEEventBus
let events: SSEEvent[]
let service: SprintPlanningService

const mgr = makeManagerClaims()
const TASK_LIST_INTRO_PAYLOAD = { intro: 'contexto sintético' }
const TASKS_STRUCTURE = {
  name: 'Sprint nova',
  goal: 'entregar x',
  tasks: [{ title: 'Tarefa 1', type: 'task' }],
}
const RISKS_PAYLOAD = { fields: [{ id: 'risks', label: 'Riscos', value: 'nenhum identificado' }] }
const CONFIRM_PAYLOAD = { markdown: '## resumo' }

/** Espera o turno fire-and-forget assentar (status sai de generating). */
async function settle(sessionId: string): Promise<ReturnType<SprintPlanningService['get']>> {
  for (let i = 0; i < 50; i++) {
    const s = await service.get({ session_id: sessionId }, mgr)
    if (s.status !== 'generating') return Promise.resolve(s)
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('sessão não saiu de generating')
}

beforeEach(async () => {
  paths = await createTempVault()
  store = new SprintPlanningSessionStore(paths)
  runner = new FakeRunner()
  const db = createTestDb()
  repo = createTestRepo(db)
  const writer = new AtomicWriter(paths, repo)
  const audit = new AuditLogger(paths.auditLog)
  sse = new SSEEventBus()
  events = []
  const origEmit = sse.emit.bind(sse)
  sse.emit = (e) => {
    events.push(e)
    origEmit(e)
  }
  sprints = new SprintService(paths, repo, writer, audit, sse)
  service = new SprintPlanningService(
    paths,
    store,
    runner,
    repo,
    sse,
    'claude-test',
    sprints,
    async () => {
      throw new Error('materializer não usado neste teste')
    },
  )
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('start', () => {
  it('projeto desconhecido é 404; agente não-pm/manager é 403', async () => {
    await expect(service.start({ project: 'ghost' }, mgr)).rejects.toMatchObject({ status: 404 })
    await setupTestProject(paths, 'test-project')
    await expect(
      service.start({ project: 'test-project' }, makeAgentClaims({ agent_type: 'dev' })),
    ).rejects.toMatchObject({ status: 403 })
  })

  it('nasce em awaiting_user na etapa goal, sem turno de LLM', async () => {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    expect(s.status).toBe('awaiting_user')
    expect(s.current_step).toBe('goal')
    expect(s.project).toBe('test-project')
    expect(runner.prompts).toHaveLength(0)
    const payload = s.outputs['goal']?.screen_payload as { fields: Array<{ id: string }> }
    expect(payload.fields.map((f) => f.id)).toEqual(['objective'])
  })

  it('uma sessão ativa por projeto — segundo start no mesmo projeto é 409, outro projeto ok', async () => {
    await setupTestProject(paths, 'test-project')
    await setupTestProject(paths, 'outro-projeto')
    await service.start({ project: 'test-project' }, mgr)
    await expect(service.start({ project: 'test-project' }, mgr)).rejects.toMatchObject({ status: 409 })

    const s2 = await service.start({ project: 'outro-projeto' }, mgr)
    expect(s2.project).toBe('outro-projeto')
  })
})

describe('fluxo completo até review', () => {
  it('goal com texto livre dispara o turno de tasks; edição humana e avanço até review', async () => {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    expect(s.current_step).toBe('goal')

    runner.pushScreen(TASK_LIST_INTRO_PAYLOAD, { structure: TASKS_STRUCTURE })
    await service.answer(
      { session_id: s.session_id, step: 'goal', answer: { objective: 'melhorar o onboarding' } },
      mgr,
    )
    let settled = await settle(s.session_id)
    expect(settled.current_step).toBe('tasks')
    expect(settled.answers['goal']).toEqual({ objective: 'melhorar o onboarding' })
    expect(settled.outputs['tasks']?.structure).toEqual(TASKS_STRUCTURE)
    expect(runner.prompts[0]).toContain('melhorar o onboarding')

    runner.pushScreen(RISKS_PAYLOAD)
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

    runner.pushScreen(CONFIRM_PAYLOAD)
    await service.answer({ session_id: s.session_id, step: 'risks', answer: { risks: 'nenhum' } }, mgr)
    settled = await settle(s.session_id)
    expect(settled.current_step).toBe('review')

    settled = await service.answer(
      { session_id: s.session_id, step: 'review', answer: { approved: true } },
      mgr,
    )
    expect(settled.status).toBe('awaiting_user')
    expect(settled.answers['review']).toEqual({ approved: true })
  })
})

describe('captureTasks (edição humana da etapa tasks)', () => {
  async function reachTasksStep(): Promise<string> {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    runner.pushScreen({}, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { objective: 'objetivo x' } }, mgr)
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

describe('finalize', () => {
  it('exige structure da etapa tasks; chama o materializer quando pronto', async () => {
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)

    await expect(service.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 409,
    })

    const materializer = vi.fn().mockResolvedValue({
      project: 'test-project',
      sprint_id: 'sprint-x',
      new_cards_created: 1,
      new_cards_failed: [],
    })
    service = new SprintPlanningService(paths, store, runner, repo, sse, 'claude-test', sprints, materializer)

    runner.pushScreen({}, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { objective: 'objetivo x' } }, mgr)
    await settle(s.session_id)

    const result = await service.finalize({ session_id: s.session_id }, mgr)
    expect(result.sprint_id).toBe('sprint-x')
    expect(materializer).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: s.session_id }),
      TASKS_STRUCTURE,
      mgr,
    )
    expect(events.some((e) => e.type === 'SPRINT_PLANNING_FINALIZED')).toBe(true)
  })
})

describe('registra tokens', () => {
  it('token_log com op PLANNING e card_type sprint_planning', async () => {
    const spy = vi.spyOn(repo, 'logTokens')
    await setupTestProject(paths, 'test-project')
    const s = await service.start({ project: 'test-project' }, mgr)
    runner.pushScreen({}, { structure: TASKS_STRUCTURE })
    await service.answer({ session_id: s.session_id, step: 'goal', answer: { objective: 'objetivo x' } }, mgr)
    await settle(s.session_id)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'PLANNING',
        card_type: 'sprint_planning',
        model: 'claude-test',
        project: 'test-project',
      }),
    )
  })
})
```

- [ ] **Step 2: Rodar os testes**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp exec vitest run tests/service/sprint-planning.test.ts`
Expected: todos os testes passam.

- [ ] **Step 3: Commit**

```bash
git add packages/server/tests/service/sprint-planning.test.ts
git commit -m "test(server): sprint-planning.test.ts cobre goal como texto livre, sem capacidade/épico"
```

---

### Task 5: Reescrever `tests/service/sprint-materialize.test.ts`

**Files:**
- Modify: `packages/server/tests/service/sprint-materialize.test.ts`

**Interfaces:**
- Consumes: `createSprintMaterializer` sem `epics` nos deps (Task 2); `newSprintPlanningSession` sem `epic_id` na sessão.

- [ ] **Step 1: Reescrever o arquivo por completo**

Substituir todo o conteúdo de `packages/server/tests/service/sprint-materialize.test.ts` por:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { SprintPlanningService } from '../../src/services/sprint-planning.js'
import {
  SprintPlanningSessionStore,
  newSprintPlanningSession,
  type SprintPlanningContext,
} from '../../src/sprint-planning/session.js'
import { createSprintMaterializer } from '../../src/sprint-planning/materialize.js'
import { SprintService } from '../../src/services/sprint.js'
import { CardService } from '../../src/services/card.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { loadProjectMeta } from '../../src/vault/layout.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'
import type { TurnRunner } from '../../src/planning/claude-runner.js'

const mgr = makeManagerClaims()

const STRUCTURE = {
  name: 'Sprint nova',
  goal: 'entregar o essencial',
  tasks: [
    { title: 'Tarefa 1', type: 'task', body: '# Spec\nfazer', priority: 'high', tags: ['x'] },
    { title: 'Tarefa 2', type: 'feature' },
  ],
}

const inertRunner: TurnRunner = {
  runTurn: async () => {
    throw new Error('sem turnos neste teste')
  },
  cancel: () => {},
}

const EMPTY_CONTEXT: SprintPlanningContext = { target_repo: null }

let paths: Paths
let store: SprintPlanningSessionStore
let sprints: SprintService
let cards: CardService
let service: SprintPlanningService

async function readySession(project: string): Promise<string> {
  const s = newSprintPlanningSession(project, EMPTY_CONTEXT, 'review')
  s.status = 'awaiting_user'
  s.answers['review'] = { approved: true }
  s.outputs['tasks'] = { screen_payload: { markdown: 'plano' }, structure: STRUCTURE }
  await store.save(s)
  return s.session_id
}

beforeEach(async () => {
  paths = await createTempVault()
  store = new SprintPlanningSessionStore(paths)
  const db = createTestDb()
  const repo = createTestRepo(db)
  const audit = new AuditLogger(paths.auditLog)
  const sse = new SSEEventBus()
  const writer = new AtomicWriter(paths, repo)
  sprints = new SprintService(paths, repo, writer, audit, sse)
  cards = new CardService(paths, repo, writer, audit, sse)
  service = new SprintPlanningService(
    paths,
    store,
    inertRunner,
    repo,
    sse,
    'claude-test',
    sprints,
    createSprintMaterializer({ sprints, cards, modelLabel: 'claude-test', saveSession: (s) => store.save(s) }),
  )
  await setupTestProject(paths, 'proj')
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('kanban_sprint_planning_finalize', () => {
  it('materializa sprint (em planning) e as tarefas novas', async () => {
    const id = await readySession('proj')
    const r = await service.finalize({ session_id: id }, mgr)

    expect(r.project).toBe('proj')
    expect(r.new_cards_created).toBe(2)
    expect(r.new_cards_failed).toEqual([])

    const meta = await loadProjectMeta(paths, 'proj')
    expect(meta.sprints).toHaveLength(1)
    expect(meta.sprints![0]!.status).toBe('planning')
    expect(meta.sprints![0]!.name).toBe('Sprint nova')

    const files = (await fs.readdir(path.join(paths.kanbanData, 'proj'))).filter((f) => f.endsWith('.md'))
    expect(files).toHaveLength(2)

    const session = await service.get({ session_id: id }, mgr)
    expect(session.status).toBe('done')
  })

  it('falha no meio → error com checkpoint; re-chamar retoma sem duplicar', async () => {
    const id = await readySession('proj')
    const orig = sprints.createSprint.bind(sprints)
    let calls = 0
    vi.spyOn(sprints, 'createSprint').mockImplementation(async (p, c) => {
      calls++
      if (calls === 1) throw new Error('disco cheio')
      return orig(p, c)
    })

    await expect(service.finalize({ session_id: id }, mgr)).rejects.toThrow('disco cheio')
    let session = await service.get({ session_id: id }, mgr)
    expect(session.status).toBe('error')
    expect(session.materialization?.sprint_created).toBeUndefined()

    const r = await service.finalize({ session_id: id }, mgr)
    expect(r.new_cards_created).toBe(2)
    const meta = await loadProjectMeta(paths, 'proj')
    expect(meta.sprints).toHaveLength(1)
    session = await service.get({ session_id: id }, mgr)
    expect(session.status).toBe('done')
  })

  it('estrutura inválida é 400, sem efeito', async () => {
    const s = newSprintPlanningSession('proj', EMPTY_CONTEXT, 'review')
    s.status = 'awaiting_user'
    s.answers['review'] = { approved: true }
    s.outputs['tasks'] = { screen_payload: {}, structure: { name: 'x' } }
    await store.save(s)
    await expect(service.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 400,
    })
  })

  it('sessão sem structure é 409', async () => {
    const s = newSprintPlanningSession('proj', EMPTY_CONTEXT, 'goal')
    await store.save(s)
    await expect(service.finalize({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 409,
    })
  })
})
```

- [ ] **Step 2: Rodar os testes**

Run: `~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp exec vitest run tests/service/sprint-materialize.test.ts`
Expected: todos os testes passam.

- [ ] **Step 3: Commit**

```bash
git add packages/server/tests/service/sprint-materialize.test.ts
git commit -m "test(server): sprint-materialize.test.ts sem vínculo de épico"
```

---

### Task 6: Web — stepper e etapa goal

**Files:**
- Modify: `packages/web/src/sprint-plan/steps-meta.ts`
- Modify: `packages/web/src/sprint-plan/SprintPlanWizard.tsx`

**Interfaces:**
- Consumes: `SprintPlanningFinalizeResult` sem `epic_linked` (Task 1); `SprintPlanningSessionView` sem `epic_id` (Task 1).
- Produces: nenhuma interface nova — só ajustes visuais.

- [ ] **Step 1: `steps-meta.ts` — remover `capacity`, `goal` vira `form`**

Em `packages/web/src/sprint-plan/steps-meta.ts`, substituir o array `SPRINT_STEPS`:

```ts
/** As 4 etapas — poucas o bastante para um stepper linear, sem agrupar em fases. */
export const SPRINT_STEPS: readonly SprintStepMeta[] = [
  { id: 'goal', title: 'Objetivo', screen: 'form' },
  { id: 'tasks', title: 'Tarefas', screen: 'task_list' },
  { id: 'risks', title: 'Riscos', screen: 'form' },
  { id: 'review', title: 'Revisão', screen: 'confirm' },
]
```

(Comentário acima do array — "As 5 etapas" — também muda para "As 4 etapas", já refletido acima.)

- [ ] **Step 2: `SprintPlanWizard.tsx` — remover o branch `choice` morto e o tile de épico**

Remover `StepChoice` e `PlanningChoicePayload` dos imports do topo:

```ts
import type {
  PlanningConfirmPayload,
  PlanningFormPayload,
  PlanningTaskListPayload,
  SprintPlanningFinalizeResult,
  SprintPlanningSessionView,
} from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText, type McpResult } from '../api/result.js'
import { Tile } from '../metrics/widgets.js'
import { SPRINT_STEPS, sprintStepIndex, sprintStepMeta } from './steps-meta.js'
import { useSprintPlanning } from './useSprintPlanning.js'
import { StepConfirm, StepForm, StepTaskList } from '../plan/screens.js'
```

Em `StepScreen`, remover o `case 'choice':` (o dispatcher da etapa `goal` agora cai no `case 'form':` já existente):

```ts
  switch (screen) {
    case 'form':
      return <StepForm payload={payload as PlanningFormPayload} busy={busy} onSubmit={onSubmit} />
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

Em `FinalizeSummary`, remover o `Tile` de "vinculada a épico" (o campo `epic_linked` não existe mais em `SprintPlanningFinalizeResult`):

```tsx
function FinalizeSummary({ r }: { r: SprintPlanningFinalizeResult }) {
  return (
    <div className="detail">
      <div className="detail-inner wide wizard">
        <div className="detail-head">
          <h1>Sprint criada</h1>
          <span className="detail-ident mono">{r.project}</span>
        </div>
        <section className="wizard-body">
          <div className="tiles">
            <Tile label="tarefas criadas" value={String(r.new_cards_created)} />
          </div>
          {r.new_cards_failed.length > 0 && (
            <p className="banner">
              {r.new_cards_failed.length} tarefa(s) falharam:{' '}
              {r.new_cards_failed.map((f) => `#${f.index} (${f.error})`).join(', ')}
            </p>
          )}
          <p style={{ marginTop: 'var(--s-5)' }}>
            <Link to={`/board/${r.project}`}>abrir o board →</Link>
          </p>
        </section>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Typecheck do web**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web run typecheck`
Expected: sem erros.

- [ ] **Step 4: Commit**

```bash
git add packages/web/src/sprint-plan/steps-meta.ts packages/web/src/sprint-plan/SprintPlanWizard.tsx
git commit -m "feat(web): sprint wizard sem etapa capacidade; goal é formulário de texto livre"
```

---

### Task 7: Novo teste web para a etapa goal

**Files:**
- Create: `packages/web/tests/sprint-plan.test.tsx`

**Interfaces:**
- Consumes: `SprintPlanWizard` (`packages/web/src/sprint-plan/SprintPlanWizard.tsx`, Task 6), `SprintPlanningSessionView` (Task 1).

- [ ] **Step 1: Escrever o teste**

Criar `packages/web/tests/sprint-plan.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { SprintPlanningSessionView } from '@obsidiankan/types'
import type { KanbanClient } from '../src/api/client.js'
import { SprintPlanWizard } from '../src/sprint-plan/SprintPlanWizard.js'

function makeSession(overrides: Partial<SprintPlanningSessionView> = {}): SprintPlanningSessionView {
  return {
    session_id: 'sprint-plan-AAAA1111',
    project: 'proj',
    status: 'awaiting_user',
    current_step: 'goal',
    context: { target_repo: null },
    answers: {},
    outputs: {
      goal: {
        screen_payload: {
          fields: [
            {
              id: 'objective',
              label: 'Objetivo da sprint',
              help: 'Descreva o que você quer entregar nesta sprint',
            },
          ],
        },
      },
    },
    usage: { input_tokens: 0, output_tokens: 0, usd: 0, turns: 0 },
    last_error: null,
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
    ...overrides,
  }
}

function makeClient(session: SprintPlanningSessionView, extra: Partial<KanbanClient> = {}): KanbanClient {
  return {
    sprintPlanningGet: vi.fn().mockResolvedValue({ ok: true, data: session }),
    sprintPlanningAnswer: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    sprintPlanningRefine: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    sprintPlanningRetry: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    sprintPlanningCancel: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { session_id: session.session_id, status: 'cancelled' } }),
    sprintPlanningFinalize: vi.fn(),
    ...extra,
  } as unknown as KanbanClient
}

function renderWizard(client: KanbanClient, sessionId = 'sprint-plan-AAAA1111') {
  return render(
    <MemoryRouter initialEntries={[`/planejar-sprint/${sessionId}`]}>
      <Routes>
        <Route path="/planejar-sprint/:sessionId" element={<SprintPlanWizard client={client} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SprintPlanWizard — etapa goal', () => {
  it('renderiza a caixa de texto livre do objetivo, sem etapa de capacidade', async () => {
    const client = makeClient(makeSession())
    renderWizard(client)
    await waitFor(() => expect(screen.getByText('Objetivo da sprint')).toBeTruthy())
    expect(document.querySelector('.wizard-count')?.textContent).toBe('etapa 1 de 4 — Objetivo')
    expect(screen.queryByText('Capacidade')).toBeNull()
  })

  it('desabilita "Continuar" com o campo vazio; habilita e envia o texto ao preencher', async () => {
    const client = makeClient(makeSession())
    renderWizard(client)
    await waitFor(() => expect(screen.getByText('Objetivo da sprint')).toBeTruthy())

    const button = screen.getByRole('button', { name: 'Continuar' })
    expect(button).toBeDisabled()

    const textarea = document.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'Reduzir o tempo de onboarding' } })
    expect(button).not.toBeDisabled()

    fireEvent.click(button)
    await waitFor(() =>
      expect(client.sprintPlanningAnswer).toHaveBeenCalledWith('sprint-plan-AAAA1111', 'goal', {
        objective: 'Reduzir o tempo de onboarding',
      }),
    )
  })
})
```

- [ ] **Step 2: Rodar o teste**

Run: `~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/web exec vitest run tests/sprint-plan.test.tsx`
Expected: os 2 testes passam.

- [ ] **Step 3: Commit**

```bash
git add packages/web/tests/sprint-plan.test.tsx
git commit -m "test(web): SprintPlanWizard cobre a etapa goal como texto livre"
```

---

### Task 8: Verificação final

**Files:** nenhum (só comandos).

- [ ] **Step 1: Suite completa**

Run: `~/.local/share/pnpm/bin/pnpm run typecheck && ~/.local/share/pnpm/bin/pnpm run build && ~/.local/share/pnpm/bin/pnpm run test && ~/.local/share/pnpm/bin/pnpm run build:web`
Expected: tudo verde — sem erros de tipo, build ok, suite de testes (server + web) passando, build do SPA ok.

- [ ] **Step 2: Conferir manualmente com o servidor rodando (opcional, mas recomendado)**

Suba o servidor com `PLANNING_STUB=true` (evita gastar turnos reais de LLM) e clique em "sprint c/ assistente" num projeto existente no board — confirme que a etapa 1 já aparece como "Objetivo" com uma caixa de texto vazia (sem "Capacidade" antes), que o botão "Continuar" fica desabilitado até digitar algo, e que ao confirmar a etapa avança para "Tarefas" com uma lista sintética.

- [ ] **Step 3: Commit final (se houver algo pendente)**

```bash
git status
```

Se tudo já foi commitado nos passos anteriores, nada a fazer aqui.
