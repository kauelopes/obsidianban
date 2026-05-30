import { Modal, type App } from 'obsidian'
import type { Sprint } from '../../../src/types.js'

export class ChangeSprintModal extends Modal {
  private decided = false

  constructor(
    app: App,
    private readonly cardTitle: string,
    private readonly sprints: Sprint[],
    private readonly onSelect: (sprintId: string) => void,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText('Move to sprint')

    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: `Select the sprint to move "${this.cardTitle}" into.`,
    })

    const select = this.contentEl.createEl('select', {
      cls: 'kanban-mcp-change-sprint-select',
    })
    for (const sprint of this.sprints) {
      const label = sprint.status === 'planning'
        ? `${sprint.name} (planning)`
        : sprint.name
      select.createEl('option', { text: label, value: sprint.id })
    }

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const cancelBtn = row.createEl('button', { text: 'Cancel' })
    const confirmBtn = row.createEl('button', { text: 'Move', cls: 'mod-cta' })

    cancelBtn.addEventListener('click', () => {
      this.decided = true
      this.close()
    })
    confirmBtn.addEventListener('click', () => {
      this.decided = true
      const sprintId = select.value
      this.close()
      if (sprintId) this.onSelect(sprintId)
    })
    confirmBtn.focus()
  }

  override onClose(): void {
    this.decided
  }
}
