import { Modal, Notice, type App } from 'obsidian'

export interface ProjectTokenInfo {
  project: string
  token: string
  token_id: string
  actor: string
  created_at: string
  secretNotePath: string
  serverUrl: string
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

    // Claude Code CLI command — ready to paste into a terminal
    const cliCommand = `claude mcp add obsidiankan --transport sse --scope project ${this.info.serverUrl}/mcp/sse -H "Authorization: Bearer ${this.info.token}"`
    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-label',
      text: 'Claude Code — run in your project:',
    })
    const cliBox = this.contentEl.createEl('code', {
      cls: 'kanban-mcp-token-box kanban-mcp-cli-box',
      text: cliCommand,
    })
    cliBox.setAttr('aria-label', 'Claude Code CLI command')

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const copyCliBtn = row.createEl('button', { text: 'Copy command', cls: 'mod-cta' })
    copyCliBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(cliCommand)
        new Notice('Command copied to clipboard')
      } catch (err) {
        new Notice(`Clipboard copy failed — copy manually. (${(err as Error).message})`, 15000)
      }
    })
    const copyBtn = row.createEl('button', { text: 'Copy token' })
    copyBtn.addEventListener('click', async () => {
      // navigator.clipboard can reject silently on Electron when the window
      // doesn't have focus or permissions are restricted. Confirming the
      // promise resolves before showing the success Notice prevents the
      // user from thinking they captured the token when they didn't —
      // raw tokens are only shown once.
      try {
        await navigator.clipboard.writeText(this.info.token)
        new Notice('Token copied to clipboard')
      } catch (err) {
        new Notice(
          'Clipboard copy failed — select the token text above and copy ' +
          'manually before closing this modal. ' +
          `(${(err as Error).message})`,
          15000,
        )
      }
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
