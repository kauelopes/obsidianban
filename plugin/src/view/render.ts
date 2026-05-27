import type { CardSummary } from '../../../src/types.js'

export const DEFAULT_COLUMN_ORDER: ReadonlyArray<string> = [
  'backlog',
  'todo',
  'in-progress',
  'review',
  'done',
]

export interface ProjectGroup {
  project: string
  columns: string[]
  cards: Record<string, CardSummary[]>
}

/**
 * Pure aggregation from a flat card list into per-project, per-column groups.
 * Column order = DEFAULT_COLUMN_ORDER first, then any extra statuses observed
 * in insertion order. Cards within a column are sorted by position ascending.
 * Projects sorted alphabetically.
 */
export function groupBoard(cards: readonly CardSummary[]): ProjectGroup[] {
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
  const out: ProjectGroup[] = []
  const projectNames = [...byProject.keys()].sort((a, b) => a.localeCompare(b))
  for (const project of projectNames) {
    const statusMap = byProject.get(project)!
    const seen = new Set<string>()
    const columns: string[] = []
    for (const def of DEFAULT_COLUMN_ORDER) {
      columns.push(def)
      seen.add(def)
    }
    for (const st of statusMap.keys()) {
      if (!seen.has(st)) {
        columns.push(st)
        seen.add(st)
      }
    }
    const cardsMap: Record<string, CardSummary[]> = {}
    for (const st of columns) {
      const arr = statusMap.get(st) ?? []
      cardsMap[st] = [...arr].sort((a, b) => a.position - b.position)
    }
    out.push({ project, columns, cards: cardsMap })
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

export function renderBoard(
  container: HTMLElement,
  cards: readonly CardSummary[],
  today: string,
): void {
  const groups = groupBoard(cards)
  if (groups.length === 0) {
    const empty = container.createDiv({ cls: 'kanban-mcp-empty' })
    empty.setText('No cards yet')
    return
  }
  for (const g of groups) renderProject(container, g, today)
}

function renderProject(parent: HTMLElement, group: ProjectGroup, today: string): void {
  const wrap = parent.createDiv({ cls: 'kanban-mcp-project' })
  const header = wrap.createDiv({ cls: 'kanban-mcp-project-header' })
  header.createSpan({ cls: 'kanban-mcp-project-title', text: group.project })
  const total = group.columns.reduce((n, st) => n + (group.cards[st]?.length ?? 0), 0)
  const counts = group.columns
    .map((st) => `${st}:${group.cards[st]?.length ?? 0}`)
    .join(' · ')
  header.createSpan({
    cls: 'kanban-mcp-project-counts',
    text: `${total} cards — ${counts}`,
  })

  const cols = wrap.createDiv({ cls: 'kanban-mcp-columns' })
  for (const st of group.columns) {
    renderColumn(cols, st, group.cards[st] ?? [], today)
  }
}

function renderColumn(
  parent: HTMLElement,
  status: string,
  cards: readonly CardSummary[],
  today: string,
): void {
  const col = parent.createDiv({ cls: 'kanban-mcp-column' })
  col.dataset['status'] = status
  const head = col.createDiv({ cls: 'kanban-mcp-column-header' })
  head.createSpan({ cls: 'kanban-mcp-column-title', text: status })
  head.createSpan({ cls: 'kanban-mcp-column-count', text: String(cards.length) })
  const body = col.createDiv({ cls: 'kanban-mcp-column-body' })
  for (const c of cards) renderCard(body, c, today)
}

function renderCard(parent: HTMLElement, card: CardSummary, today: string): void {
  const el = parent.createDiv({ cls: 'kanban-mcp-card' })
  el.dataset['cardId'] = card.id
  el.createDiv({ cls: 'kanban-mcp-card-title', text: card.title })

  const meta = el.createDiv({ cls: 'kanban-mcp-card-meta' })
  meta.createSpan({
    cls: `kanban-mcp-priority kanban-mcp-priority-${card.priority}`,
    text: card.priority,
  })
  if (card.due_date != null) {
    const overdueCls = isOverdue(card.due_date, today) ? ' kanban-mcp-due-overdue' : ''
    meta.createSpan({
      cls: 'kanban-mcp-due' + overdueCls,
      text: card.due_date,
    })
  }
  if (card.assigned_to != null) {
    meta.createSpan({ cls: 'kanban-mcp-assignee', text: '@' + card.assigned_to })
  }
}
