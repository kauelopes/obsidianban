import type { CardSummary, Sprint } from '../../../src/types.js'

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
 * with zero cards — so columns and "+ Add card" affordances stay visible.
 * Cards in unknown statuses are appended to the end. Projects sorted
 * alphabetically.
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
  const projectNames = [...byProject.keys()].sort((a, b) => a.localeCompare(b))
  for (const project of projectNames) {
    const statusMap = byProject.get(project)!
    const shape = shapes.get(project)
    const baseColumns = shape?.columns ?? DEFAULT_COLUMN_ORDER
    const seen = new Set<string>()
    const columns: string[] = []
    for (const def of baseColumns) {
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
    const sprintFilter = shape?.selectedSprint
    for (const st of columns) {
      let arr = statusMap.get(st) ?? []
      // When the project has a sprint selected, only render cards belonging
      // to it. Cards outside the sprint still exist server-side; they're
      // just hidden from this filtered view.
      if (sprintFilter != null) {
        arr = arr.filter((c) => c.sprint_id === sprintFilter)
      }
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

export function renderBoard(
  container: HTMLElement,
  cards: readonly CardSummary[],
  today: string,
  forceProjects: readonly ProjectShape[] = [],
): void {
  const groups = groupBoard(cards, forceProjects)
  if (groups.length === 0) {
    const empty = container.createDiv({ cls: 'kanban-mcp-empty' })
    empty.setText(
      'No projects yet. Run "Create kanban project" from the command palette.',
    )
    return
  }
  const cardTitles = new Map(cards.map((c) => [c.id, c.title]))
  for (const g of groups) {
    const sprintNames = new Map(g.sprints.map((s) => [s.id, s.name]))
    renderProject(container, g, today, cardTitles, sprintNames)
  }
}

function renderProject(parent: HTMLElement, group: ProjectGroup, today: string, cardTitles: Map<string, string>, sprintNames: Map<string, string>): void {
  const wrapCls = group.archived
    ? 'kanban-mcp-project kanban-mcp-project-archived'
    : 'kanban-mcp-project'
  const wrap = parent.createDiv({ cls: wrapCls })
  wrap.setAttr('role', 'region')
  wrap.setAttr('aria-label',
    group.archived ? `Project ${group.project} (archived)` : `Project ${group.project}`)
  // ── Project header row ────────────────────────────────────────
  const header = wrap.createDiv({ cls: 'kanban-mcp-project-header' })

  const titleWrap = header.createDiv({ cls: 'kanban-mcp-project-title-wrap' })
  const title = titleWrap.createSpan({ cls: 'kanban-mcp-project-title', text: group.project })
  if (group.archived) {
    title.createSpan({ cls: 'kanban-mcp-project-archived-badge', text: ' (archived)' })
  }

  // Sprint tabs — pill buttons replacing the native <select>
  if (group.sprints.length > 0) {
    const tabs = header.createDiv({ cls: 'kanban-mcp-sprint-tabs' })
    const allTab = tabs.createEl('button', {
      cls: `kanban-mcp-sprint-tab${group.selectedSprint == null ? ' is-active' : ''}`,
      text: 'All',
      attr: { type: 'button' },
    })
    allTab.dataset['project'] = group.project
    allTab.dataset['sprintId'] = ''
    for (const s of group.sprints) {
      const tab = tabs.createEl('button', {
        cls: `kanban-mcp-sprint-tab${s.id === group.selectedSprint ? ' is-active' : ''}`,
        text: s.name,
        attr: { type: 'button' },
      })
      tab.dataset['project'] = group.project
      tab.dataset['sprintId'] = s.id
    }
  }

  // Per-project actions menu
  const menuBtn = header.createEl('button', {
    cls: 'kanban-mcp-project-menu',
    text: '⋯',
    attr: { 'type': 'button', 'aria-label': `Actions for ${group.project}` },
  })
  menuBtn.dataset['project'] = group.project
  menuBtn.dataset['archived'] = group.archived ? 'true' : 'false'

  // ── Project subtitle: card count + progress bar ───────────────
  const total = group.columns.reduce((n, st) => n + (group.cards[st]?.length ?? 0), 0)
  const done = group.cards['done']?.length ?? 0
  const inProgress = group.cards['in-progress']?.length ?? 0
  const review = group.cards['review']?.length ?? 0
  const verboseCounts = group.columns
    .map((st) => `${st}: ${group.cards[st]?.length ?? 0}`)
    .join(' · ')
  const subtitle = wrap.createDiv({ cls: 'kanban-mcp-project-subtitle' })
  const countEl = subtitle.createSpan({
    cls: 'kanban-mcp-project-counts',
    text: `${total} card${total !== 1 ? 's' : ''}`,
    attr: { title: verboseCounts },
  })
  if (total > 0) {
    const bar = subtitle.createDiv({ cls: 'kanban-mcp-progress-bar', attr: { title: verboseCounts } })
    const pctDone = (done / total) * 100
    const pctReview = (review / total) * 100
    const pctProgress = (inProgress / total) * 100
    if (pctDone > 0) bar.createDiv({ cls: 'kanban-mcp-progress-done', attr: { style: `width:${pctDone}%` } })
    if (pctReview > 0) bar.createDiv({ cls: 'kanban-mcp-progress-review', attr: { style: `width:${pctReview}%` } })
    if (pctProgress > 0) bar.createDiv({ cls: 'kanban-mcp-progress-inprogress', attr: { style: `width:${pctProgress}%` } })
  }

  // When a sprint is selected, render its goal + counts as a banner under
  // the header so the agent has the briefing visible.
  if (group.selectedSprint != null) {
    const sprint = group.sprints.find((s) => s.id === group.selectedSprint)
    if (sprint) {
      const banner = wrap.createDiv({ cls: 'kanban-mcp-sprint-banner' })
      const top = banner.createDiv({ cls: 'kanban-mcp-sprint-banner-top' })
      top.createEl('strong', { text: sprint.name })
      top.createSpan({
        cls: `kanban-mcp-sprint-status-pill kanban-mcp-sprint-status-${sprint.status}`,
        text: sprint.status,
      })
      // Forward-only transition surfaced contextually: planning → Start,
      // active → Close. Closed sprints render no button.
      if (sprint.status === 'planning') {
        const btn = top.createEl('button', {
          cls: 'kanban-mcp-sprint-action mod-cta',
          text: 'Start sprint',
          attr: { type: 'button' },
        })
        btn.dataset['project'] = group.project
        btn.dataset['sprint'] = sprint.id
        btn.dataset['action'] = 'start'
      } else if (sprint.status === 'active') {
        const btn = top.createEl('button', {
          cls: 'kanban-mcp-sprint-action',
          text: 'Close sprint',
          attr: { type: 'button' },
        })
        btn.dataset['project'] = group.project
        btn.dataset['sprint'] = sprint.id
        btn.dataset['action'] = 'close'
      }
      if (sprint.goal) {
        banner.createEl('p', { cls: 'kanban-mcp-sprint-goal', text: sprint.goal })
      }
    }
  }

  const cols = wrap.createDiv({ cls: 'kanban-mcp-columns' })
  for (const st of group.columns) {
    renderColumn(cols, group.project, st, group.cards[st] ?? [], today, cardTitles, sprintNames, group.selectedSprint != null)
  }
}

function renderColumn(
  parent: HTMLElement,
  project: string,
  status: string,
  cards: readonly CardSummary[],
  today: string,
  cardTitles: Map<string, string>,
  sprintNames: Map<string, string>,
  sprintFiltered: boolean,
): void {
  const col = parent.createDiv({ cls: 'kanban-mcp-column' })
  col.dataset['project'] = project
  col.dataset['status'] = status
  col.setAttr('role', 'list')
  col.setAttr('aria-label', `${status} (${cards.length} cards)`)
  const head = col.createDiv({ cls: 'kanban-mcp-column-header' })
  head.createSpan({ cls: 'kanban-mcp-column-title', text: status })
  head.createSpan({ cls: 'kanban-mcp-column-count', text: String(cards.length) })
  const addBtn = head.createEl('button', {
    cls: 'kanban-mcp-column-add',
    text: '+',
    attr: { 'aria-label': `Add card to ${status}`, 'type': 'button' },
  })
  addBtn.dataset['project'] = project
  addBtn.dataset['status'] = status
  const body = col.createDiv({ cls: 'kanban-mcp-column-body' })
  body.dataset['project'] = project
  body.dataset['status'] = status
  if (cards.length === 0) {
    body.createDiv({ cls: 'kanban-mcp-column-empty', text: 'Drop cards here' })
  }
  for (const c of cards) renderCard(body, c, today, cardTitles, sprintNames, sprintFiltered)
}

function renderCard(parent: HTMLElement, card: CardSummary, today: string, cardTitles: Map<string, string>, sprintNames: Map<string, string>, sprintFiltered: boolean): void {
  const archived = card.archived === true
  const cls = archived ? 'kanban-mcp-card kanban-mcp-card-archived' : 'kanban-mcp-card'
  const el = parent.createDiv({ cls })
  el.dataset['cardId'] = card.id
  // Archived cards are not draggable — restore first.
  if (!archived) el.setAttr('draggable', 'true')
  el.setAttr('role', 'listitem')
  el.setAttr('tabindex', '0')
  const parts = [card.title, `priority ${card.priority}`]
  if (archived) parts.push('archived')
  if (card.due_date) parts.push(`due ${card.due_date}`)
  if (card.assigned_to) parts.push(`assigned to ${card.assigned_to}`)
  el.setAttr('aria-label', parts.join(', '))
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
  if (card.blocked_by != null && card.blocked_by.length > 0) {
    const blockerEl = meta.createSpan({
      cls: 'kanban-mcp-blockers',
      text: `⊘ blocked`,
    })
    const names = card.blocked_by.map((id) => cardTitles.get(id) ?? id).join('\n')
    blockerEl.setAttr('title', `Blocked by:\n${names}`)
  }
  if (card.sprint_id != null && !sprintFiltered) {
    const sprintName = sprintNames.get(card.sprint_id)
    if (sprintName != null) {
      meta.createSpan({ cls: 'kanban-mcp-sprint-pill', text: sprintName })
    }
  }

  const menuBtn = meta.createEl('button', {
    cls: 'kanban-mcp-card-action kanban-mcp-card-menu',
    text: '…',
    attr: {
      'type': 'button',
      'aria-label': `Actions for ${card.title}`,
    },
  })
  menuBtn.dataset['cardId'] = card.id
}
