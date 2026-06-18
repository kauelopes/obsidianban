import { Modal, type App } from 'obsidian'
import type { WorkflowReadinessResult } from '../mcp/client.js'

export class WorkflowReadinessModal extends Modal {
  constructor(
    app: App,
    private readonly project: string,
    private readonly result: WorkflowReadinessResult,
  ) {
    super(app)
  }

  override onOpen(): void {
    const { result } = this
    this.titleEl.setText(`Workflow Readiness — ${this.project}`)

    if (!result.repo_exists) {
      this.contentEl.createEl('p', {
        cls: 'kanban-mcp-modal-error',
        text: `Repository not found: ${result.target_repo}`,
      })
    }

    // ── Skills ─────────────────────────────────────────────────────────────────
    this.contentEl.createEl('h3', { text: 'Skills' })
    this.renderFileList(result.skills.map((s) => ({
      path: s.path,
      ok: s.was_present || s.installed,
      badge: s.installed ? 'installed' : undefined,
    })))

    // ── Config files ───────────────────────────────────────────────────────────
    this.contentEl.createEl('h3', { text: 'Config' })
    this.renderFileList(result.config_files.map((f) => ({
      path: f.path,
      ok: f.was_present || f.written,
      badge: f.detail ?? (f.written ? (f.was_present ? 'updated' : 'created') : undefined),
    })))

    // ── Tokens ─────────────────────────────────────────────────────────────────
    this.contentEl.createEl('h3', { text: 'Tokens' })
    const tokensList = this.contentEl.createEl('ul', { cls: 'kanban-mcp-readiness-list' })
    this.renderTokenItem(tokensList, 'KANBAN_TOKEN (PM)', result.tokens.has_pm, result.tokens.generated_pm)
    this.renderTokenItem(tokensList, 'KANBAN_DEV_TOKEN (Dev)', result.tokens.has_dev, result.tokens.generated_dev)

    // ── Summary ────────────────────────────────────────────────────────────────
    this.contentEl.createEl('p', {
      cls: result.all_ok ? 'kanban-mcp-readiness-ok' : 'kanban-mcp-readiness-fixed',
      text: result.all_ok
        ? 'Project is ready for sprint workflow.'
        : 'Issues were found and fixed — tokens written to .claude/settings.local.json.',
    })

    this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
      .createEl('button', { text: 'Close', cls: 'mod-cta' })
      .addEventListener('click', () => this.close())
  }

  private renderFileList(items: Array<{ path: string; ok: boolean; badge?: string }>): void {
    const list = this.contentEl.createEl('ul', { cls: 'kanban-mcp-readiness-list' })
    for (const item of items) {
      const li = list.createEl('li')
      li.createSpan({ text: item.ok ? '✓ ' : '✗ ', cls: item.ok ? 'kanban-mcp-ok' : 'kanban-mcp-error' })
      li.createSpan({ text: item.path })
      if (item.badge) {
        li.createSpan({ text: ` (${item.badge})`, cls: 'kanban-mcp-installed' })
      }
    }
  }

  private renderTokenItem(
    list: HTMLElement,
    label: string,
    isPresent: boolean,
    generated?: { token: string; actor: string } | undefined,
  ): void {
    const item = list.createEl('li')
    item.createSpan({ text: '✓ ', cls: 'kanban-mcp-ok' })
    item.createSpan({ text: label })
    if (generated) {
      item.createSpan({ text: ' (generated)', cls: 'kanban-mcp-installed' })
      const wrap = item.createDiv({ cls: 'kanban-mcp-token-value' })
      wrap.createEl('code', { text: generated.token, cls: 'kanban-mcp-token-code' })
      const copy = wrap.createEl('button', { text: 'Copy', cls: 'kanban-mcp-copy-btn' })
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(generated.token).then(() => {
          copy.setText('Copied!')
          setTimeout(() => copy.setText('Copy'), 2000)
        })
      })
    }
    void isPresent // used by caller to decide whether to pass generated
  }
}
