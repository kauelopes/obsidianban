/**
 * Validação manual da estrutura final produzida pela etapa sprints_tasks —
 * o contrato entre o wizard e a materialização no board. Sem ajv, no estilo
 * do resto do codebase: cada erro carrega o caminho do campo para o retry
 * corretivo do LLM (e para o 400 do finalize) apontar o problema exato.
 */

const CARD_TYPES = ['task', 'feature', 'bug', 'chore'] as const
const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const SAFE_PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export interface FinalTask {
  title: string
  type: (typeof CARD_TYPES)[number]
  body?: string
  priority?: (typeof PRIORITIES)[number]
  tags?: string[]
}

export interface FinalSprint {
  name: string
  goal: string
  tasks: FinalTask[]
}

export interface FinalEpic {
  name: string
  objective: string
  sprints: FinalSprint[]
}

export interface FinalStructure {
  project: { name: string; target_repo?: string }
  goals?: Array<{ title: string; target_date?: string | null; notes?: string }>
  epics: FinalEpic[]
}

export function validateFinalStructure(raw: unknown): FinalStructure {
  const root = asObject(raw, 'structure')
  const project = asObject(root['project'], 'project')
  const name = asString(project['name'], 'project.name')
  if (!SAFE_PROJECT.test(name)) {
    fail('project.name', 'deve casar com [a-zA-Z0-9][a-zA-Z0-9._-]{0,63} (sem espaços)')
  }
  const targetRepo = project['target_repo']
  if (targetRepo !== undefined && typeof targetRepo !== 'string') {
    fail('project.target_repo', 'deve ser string quando presente')
  }

  const epicsRaw = root['epics']
  if (!Array.isArray(epicsRaw) || epicsRaw.length === 0) {
    fail('epics', 'deve ser um array não-vazio')
  }
  const epics = (epicsRaw as unknown[]).map((e, i) => validateEpic(e, `epics[${i}]`))

  const goals = root['goals'] === undefined ? undefined : validateGoals(root['goals'])

  return {
    project: { name, ...(typeof targetRepo === 'string' ? { target_repo: targetRepo } : {}) },
    ...(goals ? { goals } : {}),
    epics,
  }
}

function validateEpic(raw: unknown, at: string): FinalEpic {
  const e = asObject(raw, at)
  const name = asString(e['name'], `${at}.name`, 120)
  const objective = asString(e['objective'], `${at}.objective`, 1000)
  const sprintsRaw = e['sprints']
  if (!Array.isArray(sprintsRaw) || sprintsRaw.length === 0) {
    fail(`${at}.sprints`, 'deve ser um array não-vazio')
  }
  const sprints = (sprintsRaw as unknown[]).map((s, i) => validateSprint(s, `${at}.sprints[${i}]`))
  return { name, objective, sprints }
}

function validateSprint(raw: unknown, at: string): FinalSprint {
  const s = asObject(raw, at)
  const name = asString(s['name'], `${at}.name`, 80)
  const goal = asString(s['goal'], `${at}.goal`, 1000)
  const tasksRaw = s['tasks']
  if (!Array.isArray(tasksRaw) || tasksRaw.length === 0) {
    fail(`${at}.tasks`, 'deve ser um array não-vazio')
  }
  const tasks = (tasksRaw as unknown[]).map((t, i) => validateTask(t, `${at}.tasks[${i}]`))
  return { name, goal, tasks }
}

function validateTask(raw: unknown, at: string): FinalTask {
  const t = asObject(raw, at)
  const title = asString(t['title'], `${at}.title`, 200)
  const type = asString(t['type'], `${at}.type`)
  if (!(CARD_TYPES as readonly string[]).includes(type)) {
    fail(`${at}.type`, `deve ser um de: ${CARD_TYPES.join(', ')}`)
  }
  const out: FinalTask = { title, type: type as FinalTask['type'] }
  if (t['body'] !== undefined) out.body = asString(t['body'], `${at}.body`)
  if (t['priority'] !== undefined) {
    const p = asString(t['priority'], `${at}.priority`)
    if (!(PRIORITIES as readonly string[]).includes(p)) {
      fail(`${at}.priority`, `deve ser um de: ${PRIORITIES.join(', ')}`)
    }
    out.priority = p as FinalTask['priority']
  }
  if (t['tags'] !== undefined) {
    const tags = t['tags']
    if (!Array.isArray(tags) || !tags.every((x) => typeof x === 'string')) {
      fail(`${at}.tags`, 'deve ser string[]')
    }
    out.tags = tags as string[]
  }
  return out
}

function validateGoals(raw: unknown): FinalStructure['goals'] {
  if (!Array.isArray(raw)) fail('goals', 'deve ser um array')
  return (raw as unknown[]).map((g, i) => {
    const at = `goals[${i}]`
    const o = asObject(g, at)
    const title = asString(o['title'], `${at}.title`, 120)
    const out: NonNullable<FinalStructure['goals']>[number] = { title }
    const td = o['target_date']
    if (td !== undefined) {
      if (td !== null && (typeof td !== 'string' || !DATE_RE.test(td))) {
        fail(`${at}.target_date`, 'deve ser YYYY-MM-DD ou null')
      }
      out.target_date = td as string | null
    }
    if (o['notes'] !== undefined) out.notes = asString(o['notes'], `${at}.notes`, 1000)
    return out
  })
}

function asObject(v: unknown, at: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(at, 'deve ser um objeto')
  }
  return v as Record<string, unknown>
}

function asString(v: unknown, at: string, max?: number): string {
  if (typeof v !== 'string' || v.length === 0) fail(at, 'deve ser string não-vazia')
  if (max != null && (v as string).length > max) fail(at, `máximo de ${max} caracteres`)
  return v as string
}

function fail(at: string, reason: string): never {
  throw new Error(`${at}: ${reason}`)
}
