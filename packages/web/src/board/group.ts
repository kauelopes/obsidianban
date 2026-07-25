import type { CardSummary, Sprint } from '@obsidiankan/types'

/**
 * Ported from packages/plugin/src/view/render.ts. One correction on the way
 * over (D3): the plugin still says 'in-progress', but the server canonized
 * 'in_progress' and ships a migration for it. The hyphenated slug only ever
 * worked because the real column order comes from the project's _meta.json.
 */
export const DEFAULT_COLUMN_ORDER: ReadonlyArray<string> = [
  'backlog',
  'todo',
  'in_progress',
  'review',
  'done',
]

export interface ProjectGroup {
  project: string
  columns: string[]
  cards: Record<string, CardSummary[]>
  archived: boolean
  sprints: readonly Sprint[]
  selectedSprint: string | undefined
}

export interface ProjectShape {
  project: string
  columns: readonly string[]
  archived?: boolean
  sprints?: readonly Sprint[]
  /** Sprint id the user has filtered the project by; undefined = all. */
  selectedSprint?: string
}

/**
 * Pure aggregation from a flat card list into per-project, per-column groups.
 * `forceProjects` carries the authoritative column order per project (sourced
 * from the server's _meta.json); projects in that list always render — even
 * with zero cards — so empty columns stay visible.
 */
export function groupBoard(
  cards: readonly CardSummary[],
  forceProjects: readonly ProjectShape[] = [],
): ProjectGroup[] {
  const byProject = new Map<string, Map<string, CardSummary[]>>()
  for (const c of cards) {
    let proj = byProject.get(c.project)
    if (!proj) {
      proj = new Map()
      byProject.set(c.project, proj)
    }
    let col = proj.get(c.status)
    if (!col) {
      col = []
      proj.set(c.status, col)
    }
    col.push(c)
  }

  const shapes = new Map<string, {
    columns: readonly string[]
    archived: boolean
    sprints: readonly Sprint[]
    selectedSprint: string | undefined
  }>()
  for (const f of forceProjects) {
    shapes.set(f.project, {
      columns: f.columns,
      archived: f.archived === true,
      sprints: f.sprints ?? [],
      selectedSprint: f.selectedSprint,
    })
    if (!byProject.has(f.project)) byProject.set(f.project, new Map())
  }

  const out: ProjectGroup[] = []
  for (const project of [...byProject.keys()].sort((a, b) => a.localeCompare(b))) {
    const statusMap = byProject.get(project)!
    const shape = shapes.get(project)
    const seen = new Set<string>()
    const columns: string[] = []
    for (const def of shape?.columns ?? DEFAULT_COLUMN_ORDER) {
      columns.push(def)
      seen.add(def)
    }
    // Cards sitting in a status the project no longer declares still have to
    // render, or they would silently vanish from the board.
    for (const st of statusMap.keys()) {
      if (!seen.has(st)) {
        columns.push(st)
        seen.add(st)
      }
    }

    const cardsMap: Record<string, CardSummary[]> = {}
    const sprintFilter = shape?.selectedSprint
    for (const st of columns) {
      let arr = statusMap.get(st) ?? []
      if (sprintFilter != null) arr = arr.filter((c) => c.sprint_id === sprintFilter)
      cardsMap[st] = [...arr].sort((a, b) => a.position - b.position)
    }

    out.push({
      project,
      columns,
      cards: cardsMap,
      archived: shape?.archived === true,
      sprints: shape?.sprints ?? [],
      selectedSprint: shape?.selectedSprint,
    })
  }
  return out
}

export function todayString(d: Date = new Date()): string {
  const yyyy = d.getFullYear().toString().padStart(4, '0')
  const mm = (d.getMonth() + 1).toString().padStart(2, '0')
  const dd = d.getDate().toString().padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

export function isOverdue(due: string | null, today: string): boolean {
  return due != null && due < today
}

// ─── Incremental list patches ────────────────────────────────────────────────
// The plugin rebuilt the whole board on every SSE event (contentEl.empty()),
// destroying scroll position and any in-flight drag. These keep the update
// surgical so React only re-renders the card that actually changed.

export function replaceCard(cards: readonly CardSummary[], updated: CardSummary): CardSummary[] {
  return cards.map((c) => (c.id === updated.id ? updated : c))
}

export function patchCard(
  cards: readonly CardSummary[],
  id: string,
  patch: Partial<CardSummary>,
): CardSummary[] {
  return cards.map((c) => (c.id === id ? { ...c, ...patch } : c))
}

export function upsertCard(cards: readonly CardSummary[], card: CardSummary): CardSummary[] {
  return cards.some((c) => c.id === card.id)
    ? replaceCard(cards, card)
    : [...cards, card]
}

export function removeCard(cards: readonly CardSummary[], id: string): CardSummary[] {
  return cards.filter((c) => c.id !== id)
}
