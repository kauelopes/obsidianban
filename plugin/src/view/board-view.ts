import { ItemView, type WorkspaceLeaf } from 'obsidian'
import type KanbanPlugin from '../main.js'
import { renderBoard, todayString } from './render.js'

export const VIEW_TYPE_KANBAN_BOARD = 'kanban-mcp-board'

export class KanbanBoardView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private readonly plugin: KanbanPlugin) {
    super(leaf)
  }

  override getViewType(): string {
    return VIEW_TYPE_KANBAN_BOARD
  }

  override getDisplayText(): string {
    return 'Kanban'
  }

  override getIcon(): string {
    return 'kanban-square'
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass('kanban-mcp-board')
    await this.refresh()
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty()
  }

  async refresh(): Promise<void> {
    const client = this.plugin.client
    this.contentEl.empty()
    if (!client) {
      this.renderError('Plugin not initialized')
      return
    }
    const result = await client.listCards()
    if (!result.ok) {
      this.renderError(`MCP ${result.error.kind}: ${result.error.message}`)
      return
    }
    renderBoard(this.contentEl, result.data.cards, todayString())
  }

  private renderError(msg: string): void {
    this.contentEl.createDiv({ cls: 'kanban-mcp-error', text: msg })
  }
}
