import type { CardSummary, EscalationItem, Goal, Sprint } from '@obsidiankan/types'
import type { ProjectInfo } from '../board/useBoard.js'

/**
 * View-model da home, derivado inteiro do que o useBoard já carrega — nenhuma
 * chamada extra. O progresso da sprint ativa vem da contagem client-side dos
 * cards com o sprint_id dela (mesma janela de 200 cards que o board vive);
 * kanban_get_sprint daria o número exato ao custo de N chamadas por render.
 */

export interface ProjectOverview {
  project: string
  archived: boolean
  /** Contagem por status na ordem das colunas do projeto. */
  statusCounts: Array<{ status: string; count: number }>
  total: number
  review: CardSummary[]
  escalations: EscalationItem[]
  active: { sprint: Sprint; done: number; total: number } | null
  planned: Sprint[]
  goals: Goal[]
  /** Máximo de updated_at entre os cards — null num projeto sem cards. */
  lastUpdate: string | null
}

export function buildOverview(
  cards: readonly CardSummary[],
  projects: readonly ProjectInfo[],
  escalations: readonly EscalationItem[],
): ProjectOverview[] {
  const byProject = new Map<string, CardSummary[]>()
  for (const c of cards) {
    const list = byProject.get(c.project)
    if (list) list.push(c)
    else byProject.set(c.project, [c])
  }

  // Projetos vêm de listProjects quando o token enxerga; cards órfãos de
  // projeto desconhecido (token dev) ainda aparecem, inferidos dos cards.
  // Projeto sabidamente arquivado não vira tile mesmo que ainda tenha cards
  // na janela — arquivar é pedir para sair da supervisão.
  const archived = new Set(projects.filter((p) => p.archived).map((p) => p.project))
  const names = new Set<string>(
    [...projects.map((p) => p.project), ...byProject.keys()].filter((n) => !archived.has(n)),
  )

  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => {
    const info = projects.find((p) => p.project === name)
    const own = byProject.get(name) ?? []
    const visible = own.filter((c) => !c.archived)

    const columns = info?.columns ?? defaultColumns(visible)
    const statusCounts = columns.map((status) => ({
      status,
      count: visible.filter((c) => c.status === status).length,
    }))

    const sprints = info?.sprints ?? []
    const activeSprint = sprints.find((s) => s.status === 'active') ?? null
    const inSprint = activeSprint ? own.filter((c) => c.sprint_id === activeSprint.id) : []

    const lastUpdate = own.reduce<string | null>(
      (max, c) => (max === null || c.updated_at > max ? c.updated_at : max),
      null,
    )

    return {
      project: name,
      archived: info?.archived ?? false,
      statusCounts,
      total: visible.length,
      review: visible.filter((c) => c.status === 'review'),
      escalations: escalations.filter((e) => e.project === name),
      active: activeSprint
        ? {
            sprint: activeSprint,
            done: inSprint.filter((c) => c.status === 'done').length,
            total: inSprint.length,
          }
        : null,
      planned: sprints.filter((s) => s.status === 'planning'),
      goals: info?.goals ?? [],
      lastUpdate,
    }
  })
}

/**
 * União por id, com `primary` ganhando: os cards do board chegam frescos por
 * SSE, o extra é um snapshot que só existe para cobrir o que ficou fora da
 * janela de 200 no mount.
 */
export function mergeCards(
  primary: readonly CardSummary[],
  extra: readonly CardSummary[],
): CardSummary[] {
  const seen = new Set(primary.map((c) => c.id))
  return [...primary, ...extra.filter((c) => !seen.has(c.id))]
}

const PRIORITY_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 }

/** Prioridade maior primeiro; empate vai para quem espera há mais tempo. */
export function compareReview(a: CardSummary, b: CardSummary): number {
  const rank = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0)
  return rank !== 0 ? rank : a.updated_at.localeCompare(b.updated_at)
}

/** Escalação mais antiga primeiro — é a decisão mais cara de adiar. */
export function compareEscalation(a: EscalationItem, b: EscalationItem): number {
  return (a.escalated_at ?? a.updated_at).localeCompare(b.escalated_at ?? b.updated_at)
}

function defaultColumns(cards: readonly CardSummary[]): string[] {
  const base = ['backlog', 'todo', 'in_progress', 'review', 'done']
  for (const c of cards) if (!base.includes(c.status)) base.push(c.status)
  return base
}
