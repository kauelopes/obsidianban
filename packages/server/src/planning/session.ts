import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import { logger } from '../util/logger.js'

export type PlanningStatus =
  | 'awaiting_user'   // tela pronta, esperando resposta humana
  | 'generating'      // turno do claude em andamento
  | 'materializing'
  | 'done'
  | 'error'
  | 'cancelled'

export type StepId =
  | 'identity'
  | 'project_type'
  | 'scope'
  | 'users'
  | 'stories'
  | 'use_cases'
  | 'domain_model'
  | 'modules'
  | 'communication'
  | 'roadmap'
  | 'milestones'
  | 'epics_features'
  | 'sprints_tasks'
  | 'risks_metrics'
  | 'review'

export type KadDocId =
  | 'vision'
  | 'prd'
  | 'domain_model'
  | 'architecture'
  | 'knowledge'
  | 'features'
  | 'stories'
  | 'roadmap'

export const KAD_DOC_IDS: readonly KadDocId[] = [
  'vision',
  'prd',
  'domain_model',
  'architecture',
  'knowledge',
  'features',
  'stories',
  'roadmap',
]

/** Checkpoint da materialização — cada fase concluída registra o que criou. */
export interface MaterializationCheckpoint {
  project_created?: boolean
  /** nome do épico (na estrutura final) → id criado */
  epics?: Record<string, string>
  /** "épico/sprint" → id criado */
  sprints?: Record<string, string>
  /** sprint_id → quantos cards já criados */
  cards?: Record<string, number>
  goals_done?: boolean
  kad_written?: boolean
  repo_copied?: boolean
}

export interface PlanningSession {
  session_id: string                 // plan-{nanoid(8)}
  claude_session_id: string | null   // capturado no 1º turno; --resume nos seguintes
  status: PlanningStatus
  current_step: StepId
  /** Resposta humana confirmada por etapa. */
  answers: Partial<Record<StepId, unknown>>
  /** Saída estruturada do LLM por etapa (pré-preenchimento, diagrama, estrutura final). */
  outputs: Partial<Record<StepId, unknown>>
  /** Markdown acumulado dos documentos KAD, doc a doc. */
  kad: Partial<Record<KadDocId, string>>
  project_name: string | null
  target_repo: string | null
  usage: { input_tokens: number; output_tokens: number; usd: number; turns: number }
  last_error: string | null
  /** Prompt do último turno disparado — o que planning_retry re-executa após um erro. */
  last_prompt: string | null
  materialization?: MaterializationCheckpoint
  created_at: string
  updated_at: string
}

const NANOID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function generatePlanningSessionId(): string {
  let id = 'plan-'
  const arr = new Uint8Array(8)
  crypto.getRandomValues(arr)
  for (const b of arr) id += NANOID_ALPHABET[b % NANOID_ALPHABET.length]
  return id
}

export function newPlanningSession(firstStep: StepId): PlanningSession {
  const now = new Date().toISOString()
  return {
    session_id: generatePlanningSessionId(),
    claude_session_id: null,
    status: 'awaiting_user',
    current_step: firstStep,
    answers: {},
    outputs: {},
    kad: {},
    project_name: null,
    target_repo: null,
    usage: { input_tokens: 0, output_tokens: 0, usd: 0, turns: 0 },
    last_error: null,
    last_prompt: null,
    created_at: now,
    updated_at: now,
  }
}

const SESSION_ID_RE = /^plan-[0-9A-Za-z]{8}$/

/**
 * Persistência das sessões de planejamento em .kanban/planning/<id>.json —
 * fora do vault visível (Obsidian não indexa) e fora do watcher (que só
 * observa kanban-data/). Escrita .tmp → rename, mesma disciplina do
 * AtomicWriter sem o acoplamento a cards.
 */
export class PlanningSessionStore {
  private readonly dir: string

  constructor(paths: Paths) {
    this.dir = path.join(paths.kanbanInternal, 'planning')
  }

  get baseDir(): string {
    return this.dir
  }

  async save(session: PlanningSession): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    session.updated_at = new Date().toISOString()
    const file = path.join(this.dir, `${session.session_id}.json`)
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(session, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  }

  async load(sessionId: string): Promise<PlanningSession | null> {
    if (!SESSION_ID_RE.test(sessionId)) return null
    try {
      const raw = await fs.readFile(path.join(this.dir, `${sessionId}.json`), 'utf8')
      return JSON.parse(raw) as PlanningSession
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, sessionId }, 'planning: failed to load session')
      }
      return null
    }
  }

  async list(): Promise<PlanningSession[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err }, 'planning: failed to list sessions')
      }
      return []
    }
    const out: PlanningSession[] = []
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const session = await this.load(name.slice(0, -'.json'.length))
      if (session) out.push(session)
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at))
  }
}

export const TERMINAL_STATUSES: readonly PlanningStatus[] = ['done', 'cancelled']

export function isActiveSession(s: PlanningSession): boolean {
  return !TERMINAL_STATUSES.includes(s.status)
}
