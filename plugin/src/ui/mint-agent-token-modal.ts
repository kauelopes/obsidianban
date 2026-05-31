import { Modal, type App } from 'obsidian'

export interface MintAgentTokenInput {
  actor: string
}

export class MintAgentTokenModal extends Modal {
  constructor(
    app: App,
    private readonly project: string,
    private readonly agentType: 'pm' | 'dev',
    private readonly onSubmit: (input: MintAgentTokenInput) => void | Promise<void>,
  ) {
    super(app)
  }

  override onOpen(): void {
    const label = this.agentType === 'pm'
      ? 'PM agent — full update access'
      : 'Dev agent — log-only (kanban_log_on_card)'

    this.titleEl.setText(`New ${this.agentType.toUpperCase()} token — ${this.project}`)
    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: `${label}. The token is shown once — write it down.`,
    })

    const input = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: `Actor name — e.g. agent:${this.agentType}-claude` },
    })
    input.focus()

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const btn = row.createEl('button', { text: 'Mint token', cls: 'mod-cta' })
    const cancel = row.createEl('button', { text: 'Cancel' })
    cancel.addEventListener('click', () => this.close())

    const submit = async (): Promise<void> => {
      const actor = input.value.trim()
      if (!actor) return
      this.close()
      await this.onSubmit({ actor })
    }
    btn.addEventListener('click', () => void submit())
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') void submit() })
  }
}
