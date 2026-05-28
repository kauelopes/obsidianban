import { Modal, type App } from 'obsidian'
import type { ConflictError } from '../mcp/client.js'

export interface ConflictActions {
  /** Re-issue the operation against the server's current_version. */
  keepMine: () => void | Promise<void>
  /** Discard local state and refresh from the server. */
  keepTheirs: () => void | Promise<void>
}

/**
 * Surfaces a 409 from the MCP. Shows version mismatch + conflicting fields
 * and offers two resolutions. Per PRD §11 the modal can grow a third
 * "Edit manually" path; left for a later iteration.
 */
export class ConflictModal extends Modal {
  constructor(
    app: App,
    private readonly conflict: ConflictError,
    private readonly actions: ConflictActions,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText('Card changed elsewhere')
    const ct = this.contentEl

    ct.createDiv({
      cls: 'kanban-mcp-conflict-info',
      text: `Your version: ${this.conflict.yourVersion} · Server: ${this.conflict.currentVersion}`,
    })

    if (this.conflict.conflictingFields.length > 0) {
      ct.createDiv({
        cls: 'kanban-mcp-conflict-fields',
        text: `Conflicting fields: ${this.conflict.conflictingFields.join(', ')}`,
      })
    }

    if (this.conflict.message) {
      ct.createDiv({ cls: 'kanban-mcp-conflict-msg', text: this.conflict.message })
    }

    const row = ct.createDiv({ cls: 'kanban-mcp-conflict-buttons' })

    const keepMine = row.createEl('button', {
      text: 'Keep mine (retry)',
      cls: 'mod-cta',
    })
    keepMine.addEventListener('click', async () => {
      this.close()
      await this.actions.keepMine()
    })

    const keepTheirs = row.createEl('button', { text: 'Use server version' })
    keepTheirs.addEventListener('click', async () => {
      this.close()
      await this.actions.keepTheirs()
    })
  }
}
