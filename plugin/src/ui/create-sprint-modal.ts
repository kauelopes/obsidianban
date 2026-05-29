import { Modal, type App } from 'obsidian'

export interface CreateSprintInput {
  name: string
  goal: string
}

export class CreateSprintModal extends Modal {
  constructor(
    app: App,
    private readonly project: string,
    private readonly onSubmit: (input: CreateSprintInput) => void | Promise<void>,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText(`New sprint for ${this.project}`)
    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text:
        'A sprint is a named, time-boxed group of cards. The goal text is ' +
        'shown to agents that work on the board.',
    })

    const nameInput = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: 'Sprint name (e.g. Sprint 5 — Auth)' },
    })
    nameInput.focus()

    const goalInput = this.contentEl.createEl('textarea', {
      cls: 'kanban-mcp-modal-input kanban-mcp-modal-textarea',
      attr: { placeholder: 'Sprint goal (optional, max 1000 chars)' },
    })

    const submit = async (): Promise<void> => {
      const name = nameInput.value.trim()
      const goal = goalInput.value.trim()
      if (!name) return
      this.close()
      await this.onSubmit({ name, goal })
    }

    // Modal does not extend Component — bare addEventListener is the
    // documented exception (DOM dies with the modal on close).
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
    })

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const btn = row.createEl('button', { text: 'Create sprint', cls: 'mod-cta' })
    btn.addEventListener('click', () => void submit())
  }
}
