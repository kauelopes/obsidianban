import { Modal, Notice, type App } from 'obsidian'

export interface ProjectTokenInfo {
  project: string
  token: string
  token_id: string
  actor: string
  created_at: string
  secretNotePath: string
}

export class ProjectTokenModal extends Modal {
  constructor(app: App, private readonly info: ProjectTokenInfo) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText(`Token for ${this.info.project}`)

    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text:
        'This token is shown once. Copy it into the agent configuration now ' +
        '— the server only stores its hash.',
    })

    const dl = this.contentEl.createEl('dl', { cls: 'kanban-mcp-token-meta' })
    addRow(dl, 'Project', this.info.project)
    addRow(dl, 'Actor', this.info.actor)
    addRow(dl, 'Token id', this.info.token_id)
    addRow(dl, 'Created', this.info.created_at)

    const tokenBox = this.contentEl.createEl('code', {
      cls: 'kanban-mcp-token-box',
      text: this.info.token,
    })
    tokenBox.setAttr('aria-label', 'agent token (copy this)')

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const copyBtn = row.createEl('button', { text: 'Copy token', cls: 'mod-cta' })
    copyBtn.addEventListener('click', () => {
      void navigator.clipboard.writeText(this.info.token)
      new Notice('Token copied to clipboard')
    })
    const closeBtn = row.createEl('button', { text: 'Done' })
    closeBtn.addEventListener('click', () => this.close())

    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: `A copy of these details was written to: ${this.info.secretNotePath}`,
    })
  }
}

function addRow(dl: HTMLElement, label: string, value: string): void {
  dl.createEl('dt', { text: label })
  dl.createEl('dd', { text: value })
}
