import { Modal, type App } from 'obsidian'

export class DeleteProjectModal extends Modal {
  constructor(
    app: App,
    private readonly project: string,
    private readonly cardCount: number,
    private readonly onConfirm: () => void | Promise<void>,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText(`Delete project "${this.project}"?`)

    const warn = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-warning' })
    warn.createEl('p', {
      text:
        `This permanently removes the project folder, ${this.cardCount} card` +
        `${this.cardCount === 1 ? '' : 's'}, and every agent token issued for ` +
        'this project. There is no undo.',
    })
    warn.createEl('p', {
      text: `Type the project name (${this.project}) below to confirm.`,
    })

    const input = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: this.project, 'aria-label': 'Type project name to confirm' },
    })
    input.focus()

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const confirmBtn = row.createEl('button', { text: 'Delete', cls: 'mod-warning' })
    confirmBtn.setAttr('disabled', 'true')
    const cancelBtn = row.createEl('button', { text: 'Cancel' })

    const refreshConfirm = (): void => {
      if (input.value === this.project) {
        confirmBtn.removeAttribute('disabled')
      } else {
        confirmBtn.setAttr('disabled', 'true')
      }
    }
    input.addEventListener('input', refreshConfirm)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value === this.project) {
        e.preventDefault()
        void submit()
      }
    })

    const submit = async (): Promise<void> => {
      if (input.value !== this.project) return
      this.close()
      await this.onConfirm()
    }
    confirmBtn.addEventListener('click', () => void submit())
    cancelBtn.addEventListener('click', () => this.close())
  }
}
