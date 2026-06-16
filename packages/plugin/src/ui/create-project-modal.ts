import { Modal, type App } from 'obsidian'

export interface CreateProjectInput {
  project: string
  actor: string
  target_repo?: string
}

export interface CreateProjectOptions {
  /** When set, the project input is pre-filled and locked — used by the
   *  per-project "Mint new token" flow which targets an existing project. */
  presetProject?: string
}

export class CreateProjectModal extends Modal {
  constructor(
    app: App,
    private readonly onSubmit: (input: CreateProjectInput) => void | Promise<void>,
    private readonly opts: CreateProjectOptions = {},
  ) {
    super(app)
  }

  override onOpen(): void {
    const reMint = this.opts.presetProject != null
    this.titleEl.setText(reMint ? `New token for ${this.opts.presetProject}` : 'New kanban project')
    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: reMint
        ? 'Mints an additional agent token for this project. Prior tokens stay valid.'
        : 'Creates the project folder under kanban-data/ and mints a fresh ' +
          'agent token. The token is shown once — write it down.',
    })

    const projectInput = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: 'Project name — letters, numbers, . _ - (e.g. marketing)' },
    })
    const projectError = this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-error',
      text: 'Name may only contain letters, numbers, dots, underscores, and hyphens — no spaces.',
    })
    projectError.style.display = 'none'
    if (reMint) {
      projectInput.value = this.opts.presetProject ?? ''
      projectInput.setAttr('readonly', 'true')
    }
    projectInput.focus()

    const actorInput = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: 'Agent actor (e.g. agent:claude)' },
    })
    actorInput.value = 'agent:claude'
    if (reMint) actorInput.focus()

    const repoInput = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: 'Target repo path (optional, e.g. /home/user/my-repo)' },
    })

    const VALID_PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
    projectInput.addEventListener('input', () => {
      const v = projectInput.value.trim()
      projectError.style.display = v && !VALID_PROJECT.test(v) ? '' : 'none'
    })

    const submit = async (): Promise<void> => {
      const project = projectInput.value.trim()
      const actor = actorInput.value.trim()
      if (!project || !actor) return
      if (!VALID_PROJECT.test(project)) {
        projectError.style.display = ''
        projectInput.focus()
        return
      }
      const target_repo = repoInput.value.trim() || undefined
      this.close()
      await this.onSubmit({ project, actor, target_repo })
    }

    // Modal does not extend Component — bare addEventListener is the
    // documented exception (DOM dies with the modal on close).
    const onEnter = (e: KeyboardEvent): void => {
      if (e.key === 'Enter') void submit()
    }
    projectInput.addEventListener('keydown', onEnter)
    actorInput.addEventListener('keydown', onEnter)
    repoInput.addEventListener('keydown', onEnter)

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const btn = row.createEl('button', { text: 'Create', cls: 'mod-cta' })
    btn.addEventListener('click', () => void submit())
  }
}
