import { Plugin } from 'obsidian'
import { McpClient } from './mcp/client.js'
import { SSESubscriber, type SSEFrame } from './mcp/sse-subscriber.js'
import { DEFAULT_SETTINGS, type KanbanPluginSettings } from './settings.js'
import { KanbanSettingsTab } from './settings-tab.js'
import { KanbanBoardView, VIEW_TYPE_KANBAN_BOARD } from './view/board-view.js'

export default class KanbanPlugin extends Plugin {
  settings: KanbanPluginSettings = DEFAULT_SETTINGS
  client: McpClient | null = null
  private subscriber: SSESubscriber | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()
    this.client = new McpClient({
      baseUrl: this.settings.baseUrl,
      token: this.settings.token,
    })

    this.registerView(VIEW_TYPE_KANBAN_BOARD, (leaf) => new KanbanBoardView(leaf, this))

    this.addSettingTab(new KanbanSettingsTab(this.app, this))

    this.addCommand({
      id: 'open-kanban-board',
      name: 'Open kanban board',
      callback: () => {
        void this.activateBoard()
      },
    })

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
    this.subscriber = new SSESubscriber({
      baseUrl: this.settings.baseUrl,
      onEvent: (frame) => this.dispatchSseEvent(frame),
    })
    this.subscriber.start()
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
