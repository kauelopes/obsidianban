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
