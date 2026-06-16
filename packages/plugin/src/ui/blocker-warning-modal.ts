import { Modal, type App } from 'obsidian'

export interface PendingBlocker {
  id: string
  title: string
  status: string
}

export class BlockerWarningModal extends Modal {
  constructor(
    app: App,
    private readonly cardTitle: string,
    private readonly blockers: PendingBlocker[],
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText('Pending dependencies')

    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: `"${this.cardTitle}" cannot be moved — it is blocked by:`,
    })

    const list = this.contentEl.createEl('ul', { cls: 'kanban-mcp-blocker-list' })
    for (const b of this.blockers) {
      const item = list.createEl('li', { cls: 'kanban-mcp-blocker-item' })
      item.createSpan({ cls: 'kanban-mcp-blocker-title', text: b.title })
      item.createSpan({ cls: 'kanban-mcp-blocker-status', text: b.status })
    }

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const okBtn = row.createEl('button', { text: 'OK', cls: 'mod-cta' })
    okBtn.addEventListener('click', () => this.close())
    okBtn.focus()
  }
}
