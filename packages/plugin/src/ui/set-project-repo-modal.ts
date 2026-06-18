import { Modal, Notice, type App } from 'obsidian'
import type { McpClient } from '../mcp/client.js'
import { WorkflowReadinessModal } from './workflow-readiness-modal.js'

export class SetProjectRepoModal extends Modal {
  constructor(
    app: App,
    private readonly project: string,
    private readonly currentRepo: string | undefined,
    private readonly client: McpClient,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText(`Set target repo — ${this.project}`)
    this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: 'Absolute path to the git repo used as the working directory when launching sprint workflows for this project. Leave blank to clear — without this, starting a sprint will skip the workflow and log a warning.',
    })

    const repoInput = this.contentEl.createEl('input', {
      type: 'text',
      cls: 'kanban-mcp-modal-input',
      attr: { placeholder: '/home/user/my-repo' },
    })
    repoInput.value = this.currentRepo ?? ''
    repoInput.focus()

    const submit = async (): Promise<void> => {
      const value = repoInput.value.trim()
      const target_repo = value.length > 0 ? value : null
      this.close()
      const res = await this.client.setProjectRepo({ project: this.project, target_repo })
      if (res.ok) {
        if (target_repo && res.data.workflow_readiness) {
          new WorkflowReadinessModal(this.app, this.project, res.data.workflow_readiness).open()
        } else {
          new Notice('Target repo cleared.')
        }
      } else {
        new Notice(`Failed to set target repo: ${res.error.message}`, 8000)
      }
    }

    repoInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') void submit()
    })

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const btn = row.createEl('button', { text: 'Save', cls: 'mod-cta' })
    btn.addEventListener('click', () => void submit())
  }
}
