import { Modal, type App } from 'obsidian'

export interface ConfirmModalOptions {
  title: string
  body: string
  confirmLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

/**
 * Replaces `window.confirm`, which on Electron/Obsidian leaves the renderer
 * in a focus-stuck state — after dismissal, subsequent modals appear but
 * their inputs reject clicks and keypresses. This Obsidian-native confirm
 * sidesteps that without losing the synchronous-ish UX.
 */
export class ConfirmModal extends Modal {
  private decided = false

  constructor(
    app: App,
    private readonly opts: ConfirmModalOptions,
    private readonly onDecision: (confirmed: boolean) => void,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText(this.opts.title)
    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: this.opts.body,
    })
    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const cancelBtn = row.createEl('button', {
      text: this.opts.cancelLabel ?? 'Cancel',
    })
    const confirmBtn = row.createEl('button', {
      text: this.opts.confirmLabel ?? 'Confirm',
      cls: this.opts.destructive ? 'mod-warning' : 'mod-cta',
    })
    cancelBtn.addEventListener('click', () => {
      this.decided = true
      this.close()
      this.onDecision(false)
    })
    confirmBtn.addEventListener('click', () => {
      this.decided = true
      this.close()
      this.onDecision(true)
    })
    confirmBtn.focus()
  }

  override onClose(): void {
    // Closing via Esc or outside-click counts as cancellation; the click
    // handlers above set `decided=true` first so we don't double-fire.
    if (!this.decided) this.onDecision(false)
  }
}
