import { Modal, type App } from 'obsidian'

export interface CreateProjectInput {
  project: string
  actor: string
}

export class CreateProjectModal extends Modal {
  constructor(
    app: App,
    private readonly onSubmit: (input: CreateProjectInput) => void | Promise<void>,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText('New kanban project')
    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text:
        'Creates the project folder under kanban-data/ and mints a fresh ' +
        'agent token. The token is shown once — write it down.',
    })

    const projectInput = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: 'Project name (e.g. marketing)' },
    })
    projectInput.focus()

    const actorInput = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: 'Agent actor (e.g. agent:claude)' },
    })
    actorInput.value = 'agent:claude'

    const submit = async (): Promise<void> => {
      const project = projectInput.value.trim()
      const actor = actorInput.value.trim()
      if (!project || !actor) return
      this.close()
      await this.onSubmit({ project, actor })
    }

    // Modal does not extend Component — bare addEventListener is the
    // documented exception (DOM dies with the modal on close).
    const onEnter = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') void submit()
    }
    projectInput.addEventListener('keydown', onEnter)
    actorInput.addEventListener('keydown', onEnter)

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const btn = row.createEl('button', { text: 'Create', cls: 'mod-cta' })
    btn.addEventListener('click', () => void submit())
  }
}
