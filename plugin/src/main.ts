import { Notice, Plugin } from 'obsidian'
import { McpClient } from './mcp/client.js'
import { SSESubscriber, type SSEFrame, type SseStatus } from './mcp/sse-subscriber.js'
import { DEFAULT_SETTINGS, type KanbanPluginSettings } from './settings.js'
import { KanbanSettingsTab } from './settings-tab.js'
import { registerCardBanner } from './editor/card-banner.js'
import { CreateProjectModal } from './ui/create-project-modal.js'
import { ProjectTokenModal } from './ui/project-token-modal.js'
import { KanbanBoardView, VIEW_TYPE_KANBAN_BOARD } from './view/board-view.js'
import { KanbanMetricsView, VIEW_TYPE_KANBAN_METRICS } from './view/metrics-view.js'

export default class KanbanPlugin extends Plugin {
  settings: KanbanPluginSettings = DEFAULT_SETTINGS
  client: McpClient | null = null
  /** Last status reported by the SSE subscriber; drives the offline banner. */
  connectionStatus: SseStatus = 'connecting'
  private subscriber: SSESubscriber | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()
    this.client = new McpClient({
      baseUrl: this.settings.baseUrl,
      token: this.settings.token,
    })

    this.registerView(VIEW_TYPE_KANBAN_BOARD, (leaf) => new KanbanBoardView(leaf, this))
    this.registerView(VIEW_TYPE_KANBAN_METRICS, (leaf) => new KanbanMetricsView(leaf, this))

    this.addSettingTab(new KanbanSettingsTab(this.app, this))

    this.addCommand({
      id: 'open-kanban-board',
      name: 'Open kanban board',
      callback: () => {
        void this.activateBoard()
      },
    })

    this.addCommand({
      id: 'show-metrics-panel',
      name: 'Show metrics panel',
      callback: () => {
        void this.activateMetrics()
      },
    })

    this.addCommand({
      id: 'create-kanban-project',
      name: 'Create kanban project',
      callback: () => {
        this.promptCreateProject()
      },
    })

    registerCardBanner(this)

    this.startSubscriber()
    this.register(() => this.subscriber?.stop())
  }

  override onunload(): void {
    // RULE-05: never detachLeavesOfType here — Obsidian restores leaves on
    // reload and detaching here would erase the user's workspace.
    // Subscriber cleanup is handled by the register() callback above.
  }

  private startSubscriber(): void {
    this.subscriber?.stop()
    // Cap reconnect backoff at 5s so the offline banner clears quickly
    // once the MCP is reachable again (PRD §11.4 health polling).
    this.subscriber = new SSESubscriber({
      baseUrl: this.settings.baseUrl,
      onEvent: (frame) => this.dispatchSseEvent(frame),
      onStatusChange: (status) => this.handleStatusChange(status),
      backoffMaxMs: 5000,
    })
    this.subscriber.start()
  }

  private handleStatusChange(status: SseStatus): void {
    if (this.connectionStatus === status) return
    this.connectionStatus = status
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN_BOARD)) {
      const view = leaf.view
      if (view instanceof KanbanBoardView) view.onConnectionStatusChange(status)
    }
  }

  private dispatchSseEvent(frame: SSEFrame): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN_BOARD)) {
      const view = leaf.view
      if (view instanceof KanbanBoardView) void view.handleSseEvent(frame)
    }
  }

  async activateBoard(): Promise<void> {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_KANBAN_BOARD)
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]!)
      return
    }
    const leaf = workspace.getLeaf('tab')
    await leaf.setViewState({ type: VIEW_TYPE_KANBAN_BOARD, active: true })
    workspace.revealLeaf(leaf)
  }

  async activateMetrics(): Promise<void> {
    const { workspace } = this.app
    const existing = workspace.getLeavesOfType(VIEW_TYPE_KANBAN_METRICS)
    if (existing.length > 0) {
      workspace.revealLeaf(existing[0]!)
      return
    }
    const leaf = workspace.getRightLeaf(false)
    if (!leaf) return
    await leaf.setViewState({ type: VIEW_TYPE_KANBAN_METRICS, active: true })
    workspace.revealLeaf(leaf)
  }

  private promptCreateProject(): void {
    this.openCreateProjectModal()
  }

  /** Opens the same create/re-mint flow with the project pre-filled — used
   *  by the per-project menu's "Mint new agent token" action. */
  promptMintToken(project: string): void {
    this.openCreateProjectModal(project)
  }

  private openCreateProjectModal(presetProject?: string): void {
    if (!this.client) {
      new Notice('Plugin not initialized')
      return
    }
    new CreateProjectModal(
      this.app,
      async ({ project, actor }) => {
        const client = this.client
        if (!client) return
        const res = await client.createProject({ project, actor })
        if (!res.ok) {
          const err = res.error
          const detail =
            err.kind === 'server' && err.status === 403
              ? 'Manager token required — set it in plugin settings.'
              : `${err.kind}: ${err.message}`
          new Notice(`Create project failed — ${detail}`, 8000)
          return
        }
        const secretNotePath = `_kanban-secrets/${res.data.project}.md`
        await this.writeSecretNote(secretNotePath, res.data)
        new ProjectTokenModal(this.app, {
          ...res.data,
          secretNotePath,
        }).open()
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN_BOARD)) {
          const view = leaf.view
          if (view instanceof KanbanBoardView) void view.refresh()
        }
      },
      presetProject ? { presetProject } : {},
    ).open()
  }

  private async writeSecretNote(
    relativePath: string,
    info: { project: string; token: string; token_id: string; actor: string; created_at: string },
  ): Promise<void> {
    const folder = relativePath.slice(0, relativePath.lastIndexOf('/'))
    // adapter.exists/mkdir handle the case where _kanban-secrets/ already
    // exists from a previous project — the agent re-mint flow.
    if (!(await this.app.vault.adapter.exists(folder))) {
      await this.app.vault.adapter.mkdir(folder)
    }
    const entry = [
      `## Token ${info.token_id} — ${info.created_at}`,
      '',
      `- **Actor:** ${info.actor}`,
      '',
      '```',
      info.token,
      '```',
      '',
    ].join('\n')

    // Append-on-re-mint: previous tokens stay readable in the same note so
    // the user has a full audit trail without us silently clobbering them.
    let body: string
    if (await this.app.vault.adapter.exists(relativePath)) {
      const existing = await this.app.vault.adapter.read(relativePath)
      body = existing.trimEnd() + '\n\n' + entry
    } else {
      body = [
        `# Kanban agent tokens — ${info.project}`,
        '',
        '> Stored in your vault by the kanban plugin. The server only keeps a',
        '> hash of each token; if you lose one, mint a new one and revoke the old.',
        '',
        entry,
      ].join('\n')
    }
    await this.app.vault.adapter.write(relativePath, body)
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<KanbanPluginSettings> | null
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
    this.client = new McpClient({
      baseUrl: this.settings.baseUrl,
      token: this.settings.token,
    })
    this.startSubscriber()
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN_BOARD)) {
      const view = leaf.view
      if (view instanceof KanbanBoardView) void view.refresh()
    }
  }
}
