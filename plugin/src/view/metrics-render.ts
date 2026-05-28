import type { Metrics } from '../../../src/types.js'

const DAY_WINDOW = 30

export function formatInt(n: number): string {
  return n.toLocaleString('en-US')
}

/** Return the last N rows of by_day, ordered by date ascending. The server
 *  already sorts ASC, so we just slice the tail. */
export function lastDays<T>(rows: ReadonlyArray<T>, n: number = DAY_WINDOW): T[] {
  return rows.slice(Math.max(0, rows.length - n))
}

export function renderMetricsSummary(parent: HTMLElement, m: Metrics): void {
  const section = parent.createDiv({ cls: 'kanban-mcp-metrics-section' })
  section.createEl('h3', { cls: 'kanban-mcp-metrics-title', text: 'Summary' })
  const stats = section.createDiv({ cls: 'kanban-mcp-metrics-stats' })
  addStat(stats, 'Input tokens', formatInt(m.summary.total_input_tokens))
  addStat(stats, 'Output tokens', formatInt(m.summary.total_output_tokens))
  addStat(stats, 'Operations', formatInt(m.summary.total_ops))
}

function addStat(parent: HTMLElement, label: string, value: string): void {
  const cell = parent.createDiv({ cls: 'kanban-mcp-metrics-stat' })
  cell.createDiv({ cls: 'kanban-mcp-metrics-stat-value', text: value })
  cell.createDiv({ cls: 'kanban-mcp-metrics-stat-label', text: label })
}

export function renderTable(
  parent: HTMLElement,
  title: string,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): void {
  const section = parent.createDiv({ cls: 'kanban-mcp-metrics-section' })
  section.createEl('h3', { cls: 'kanban-mcp-metrics-title', text: title })
  if (rows.length === 0) {
    section.createDiv({ cls: 'kanban-mcp-metrics-empty', text: 'No data for this range.' })
    return
  }
  const table = section.createEl('table', { cls: 'kanban-mcp-metrics-table' })
  const thead = table.createEl('thead')
  const headerRow = thead.createEl('tr')
  for (const h of headers) headerRow.createEl('th', { text: h })
  const tbody = table.createEl('tbody')
  for (const row of rows) {
    const tr = tbody.createEl('tr')
    for (const cell of row) tr.createEl('td', { text: cell })
  }
}

export function renderAllMetrics(parent: HTMLElement, m: Metrics): void {
  renderMetricsSummary(parent, m)
  renderTable(
    parent,
    'By type',
    ['Type', 'Input', 'Output', 'Ops'],
    m.by_type.map((r) => [r.type, formatInt(r.input_tokens), formatInt(r.output_tokens), formatInt(r.ops)]),
  )
  renderTable(
    parent,
    `By day (last ${DAY_WINDOW} entries)`,
    ['Date', 'Input', 'Output'],
    lastDays(m.by_day).map((r) => [r.date, formatInt(r.input_tokens), formatInt(r.output_tokens)]),
  )
  renderTable(
    parent,
    'By model',
    ['Model', 'Input', 'Output'],
    m.by_model.map((r) => [r.model, formatInt(r.input_tokens), formatInt(r.output_tokens)]),
  )
}
