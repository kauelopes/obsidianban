import { Plugin } from 'obsidian'
import { McpClient } from './mcp/client.js'
import { DEFAULT_SETTINGS, type KanbanPluginSettings } from './settings.js'
import { KanbanBoardView, VIEW_TYPE_KANBAN_BOARD } from './view/board-view.js'

export default class KanbanPlugin extends Plugin {
  settings: KanbanPluginSettings = DEFAULT_SETTINGS
  client: McpClient | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()
    this.client = new McpClient({
      baseUrl: this.settings.baseUrl,
      token: this.settings.token,
    })

    this.registerView(VIEW_TYPE_KANBAN_BOARD, (leaf) => new KanbanBoardView(leaf, this))

    this.addCommand({
      id: 'open-kanban-board',
      name: 'Open kanban board',
      callback: () => {
        void this.activateBoard()
      },
    })
  }

  override onunload(): void {
    // RULE-05: never detachLeavesOfType here — Obsidian restores leaves on
    // reload and detaching here would erase the user's workspace.
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
  }
}
