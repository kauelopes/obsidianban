import { ItemView, type WorkspaceLeaf } from 'obsidian'
import type KanbanPlugin from '../main.js'
import { renderAllMetrics } from './metrics-render.js'

export const VIEW_TYPE_KANBAN_METRICS = 'kanban-mcp-metrics'

export class KanbanMetricsView extends ItemView {
  private fromDate = ''
  private toDate = ''

  constructor(leaf: WorkspaceLeaf, private readonly plugin: KanbanPlugin) {
    super(leaf)
  }

  override getViewType(): string {
    return VIEW_TYPE_KANBAN_METRICS
  }

  override getDisplayText(): string {
    return 'Kanban metrics'
  }

  override getIcon(): string {
    return 'bar-chart-3'
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass('kanban-mcp-metrics')
    await this.refresh()
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty()
  }

  private async refresh(): Promise<void> {
    const client = this.plugin.client
    this.contentEl.empty()
    this.renderControls()
    if (!client) {
      this.renderError('Plugin not initialized')
      return
    }
    const res = await client.getMetrics({
      from_date: this.fromDate || undefined,
      to_date: this.toDate || undefined,
    })
    if (!res.ok) {
      this.renderError(`MCP ${res.error.kind}: ${res.error.message}`)
      return
    }
    renderAllMetrics(this.contentEl, res.data)
  }

  private renderControls(): void {
    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-metrics-controls' })

    const fromLabel = row.createEl('label', { cls: 'kanban-mcp-metrics-control' })
    fromLabel.createSpan({ text: 'From' })
    const fromInput = fromLabel.createEl('input', {
      type: 'date',
      attr: { 'aria-label': 'Filter from date' },
    })
    fromInput.value = this.fromDate
    this.registerDomEvent(fromInput, 'change', () => {
      this.fromDate = fromInput.value
      void this.refresh()
    })

    const toLabel = row.createEl('label', { cls: 'kanban-mcp-metrics-control' })
    toLabel.createSpan({ text: 'To' })
    const toInput = toLabel.createEl('input', {
      type: 'date',
      attr: { 'aria-label': 'Filter to date' },
    })
    toInput.value = this.toDate
    this.registerDomEvent(toInput, 'change', () => {
      this.toDate = toInput.value
      void this.refresh()
    })

    const refreshBtn = row.createEl('button', {
      text: 'Refresh',
      cls: 'mod-cta kanban-mcp-metrics-refresh',
    })
    this.registerDomEvent(refreshBtn, 'click', () => void this.refresh())
  }

  private renderError(msg: string): void {
    this.contentEl.createDiv({ cls: 'kanban-mcp-error', text: msg })
  }
}
