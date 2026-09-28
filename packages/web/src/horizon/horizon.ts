import type { Goal } from '@obsidiankan/types'
import { diffDays } from '../util/time.js'

/**
 * Agrupamento temporal das metas de todos os projetos. A régua é derivada de
 * `target_date` — o schema de Goal não tem campo de horizonte, e inventar um
 * exigiria manutenção manual de algo que a data já responde.
 */

export interface GoalWithProject {
  goal: Goal
  project: string
}

export type HorizonBucket = 'overdue' | 'short' | 'medium' | 'long' | 'undated'

export interface HorizonGroup {
  bucket: HorizonBucket
  items: GoalWithProject[]
}

/** Ordem de exibição: urgência decrescente, sem prazo por último. */
export const BUCKET_ORDER: readonly HorizonBucket[] = [
  'overdue',
  'short',
  'medium',
  'long',
  'undated',
]

export const BUCKET_LABEL: Record<HorizonBucket, string> = {
  overdue: 'atrasadas',
  short: 'curto prazo — até 2 semanas',
  medium: 'médio prazo — 2 a 4 semanas',
  long: 'longo prazo — mais de 4 semanas',
  undated: 'sem prazo',
}

const SHORT_MAX_DAYS = 14
const MEDIUM_MAX_DAYS = 28

/**
 * Meta sem data cai em 'undated', não em 'long': não é "ainda longe", é sem
 * compromisso de tempo — e misturar as duas esconde justamente as metas que
 * deveriam ganhar uma data. Vencer hoje ainda é 'short'; só data anterior a
 * hoje é atraso (o dia não acabou).
 */
export function classifyGoal(goal: Goal, todayIso: string): HorizonBucket {
  if (goal.target_date === null) return 'undated'
  const days = diffDays(todayIso, goal.target_date)
  if (days < 0) return 'overdue'
  if (days <= SHORT_MAX_DAYS) return 'short'
  if (days <= MEDIUM_MAX_DAYS) return 'medium'
  return 'long'
}

/**
 * Só metas abertas: o Horizonte é sobre compromisso pendente, e concluída ou
 * abandonada só polui o calendário. Grupos vazios não entram na lista — quem
 * renderiza decide o que dizer quando tudo vem vazio.
 */
export function groupGoalsByHorizon(
  projects: readonly { project: string; goals?: Goal[] }[],
  todayIso: string,
): HorizonGroup[] {
  const byBucket = new Map<HorizonBucket, GoalWithProject[]>()
  for (const p of projects) {
    for (const goal of p.goals ?? []) {
      if (goal.status !== 'open') continue
      const bucket = classifyGoal(goal, todayIso)
      const list = byBucket.get(bucket)
      if (list) list.push({ goal, project: p.project })
      else byBucket.set(bucket, [{ goal, project: p.project }])
    }
  }
  return BUCKET_ORDER.flatMap((bucket) => {
    const items = byBucket.get(bucket)
    return items ? [{ bucket, items: items.sort(compareHorizonItem) }] : []
  })
}

/** Mais urgente primeiro; sem data não tem o que comparar, vai por título. */
export function compareHorizonItem(a: GoalWithProject, b: GoalWithProject): number {
  const da = a.goal.target_date
  const db = b.goal.target_date
  if (da !== null && db !== null && da !== db) return da.localeCompare(db)
  return a.goal.title.localeCompare(b.goal.title)
}

/** Todas as metas abertas com data, achatadas — entrada do calendário. */
export function datedGoals(
  projects: readonly { project: string; goals?: Goal[] }[],
): GoalWithProject[] {
  return projects.flatMap((p) =>
    (p.goals ?? [])
      .filter((g) => g.status === 'open' && g.target_date !== null)
      .map((goal) => ({ goal, project: p.project })),
  )
}
