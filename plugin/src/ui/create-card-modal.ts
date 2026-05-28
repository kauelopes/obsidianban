import { Modal, type App } from 'obsidian'

export class CreateCardModal extends Modal {
  constructor(app: App, private readonly onSubmit: (title: string) => void | Promise<void>) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText('New card')
    const input = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: 'Card title' },
    })
    input.focus()

    const submit = async (): Promise<void> => {
      const title = input.value.trim()
      if (!title) return
      this.close()
      await this.onSubmit(title)
    }

    // Modal does not extend Component — no registerDomEvent here. Listeners
    // attached to children of contentEl die with the DOM on close().
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
    })

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const btn = row.createEl('button', { text: 'Create', cls: 'mod-cta' })
    btn.addEventListener('click', () => void submit())
  }
}
