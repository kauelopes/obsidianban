import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import { logger } from '../util/logger.js'

export type SprintPlanningStatus =
  | 'awaiting_user'   // tela pronta, esperando resposta humana
  | 'generating'      // turno do claude em andamento
  | 'materializing'
  | 'done'
  | 'error'
  | 'cancelled'

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

export interface SprintPlanningStepOutput {
  screen_payload: unknown
  structure?: unknown
}

export interface SprintPlanningSession {
  session_id: string                 // sprint-plan-{nanoid(8)}
  project: string                    // obrigatório desde a criação — não há sessão sem projeto
  /** Setado quando a etapa "goal" escolhe um épico existente; null = objetivo ad-hoc. */
  epic_id: string | null
  claude_session_id: string | null   // capturado no 1º turno; --resume nos seguintes
  status: SprintPlanningStatus
  current_step: SprintStepId
  context: SprintPlanningContext
  /** Resposta humana confirmada por etapa. */
  answers: Partial<Record<SprintStepId, unknown>>
  /** Saída estruturada do LLM por etapa (pré-preenchimento, estrutura final). */
  outputs: Partial<Record<SprintStepId, SprintPlanningStepOutput>>
  usage: { input_tokens: number; output_tokens: number; usd: number; turns: number }
  last_error: string | null
  /** Prompt do último turno disparado — o que sprint_planning_retry re-executa após um erro. */
  last_prompt: string | null
  materialization?: SprintMaterializationCheckpoint
  created_at: string
  updated_at: string
}

const NANOID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function generateSprintPlanningSessionId(): string {
  let id = 'sprint-plan-'
  const arr = new Uint8Array(8)
  crypto.getRandomValues(arr)
  for (const b of arr) id += NANOID_ALPHABET[b % NANOID_ALPHABET.length]
  return id
}

export function newSprintPlanningSession(
  project: string,
  context: SprintPlanningContext,
  firstStep: SprintStepId,
): SprintPlanningSession {
  const now = new Date().toISOString()
  return {
    session_id: generateSprintPlanningSessionId(),
    project,
    epic_id: null,
    claude_session_id: null,
    status: 'awaiting_user',
    current_step: firstStep,
    context,
    answers: {},
    outputs: {},
    usage: { input_tokens: 0, output_tokens: 0, usd: 0, turns: 0 },
    last_error: null,
    last_prompt: null,
    created_at: now,
    updated_at: now,
  }
}

const SESSION_ID_RE = /^sprint-plan-[0-9A-Za-z]{8}$/

/**
 * Persistência das sessões do wizard de sprint em .kanban/planning/sprint/<id>.json
 * — subpasta própria, separada do wizard de projeto (.kanban/planning/<id>.json),
 * para as duas listagens de "sessão ativa" nunca colidirem. Mesma disciplina de
 * escrita .tmp → rename do PlanningSessionStore.
 */
export class SprintPlanningSessionStore {
  private readonly dir: string

  constructor(paths: Paths) {
    this.dir = path.join(paths.kanbanInternal, 'planning', 'sprint')
  }

  get baseDir(): string {
    return this.dir
  }

  async save(session: SprintPlanningSession): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    session.updated_at = new Date().toISOString()
    const file = path.join(this.dir, `${session.session_id}.json`)
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(session, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  }

  async load(sessionId: string): Promise<SprintPlanningSession | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null
    try {
      const raw = await fs.readFile(path.join(this.dir, `${sessionId}.json`), 'utf8')
      return JSON.parse(raw) as SprintPlanningSession
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, sessionId }, 'sprint-planning: failed to load session')
      }
      return null
    }
  }

  async list(): Promise<SprintPlanningSession[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err }, 'sprint-planning: failed to list sessions')
      }
      return []
    }
    const out: SprintPlanningSession[] = []
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const session = await this.load(name.slice(0, -'.json'.length))
      if (session) out.push(session)
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }

  /** Sessões ativas de um projeto — usado por start() para impor "uma por projeto". */
  async listActiveForProject(project: string): Promise<SprintPlanningSession[]> {
    const all = await this.list()
    return all.filter((s) => s.project === project && isActiveSession(s))
  }
}

export const TERMINAL_STATUSES: readonly SprintPlanningStatus[] = ['done', 'cancelled']

export function isActiveSession(s: SprintPlanningSession): boolean {
  return !TERMINAL_STATUSES.includes(s.status)
}
