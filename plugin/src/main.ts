import { Plugin } from 'obsidian'
import { McpClient } from './mcp/client.js'
import { DEFAULT_SETTINGS, type KanbanPluginSettings } from './settings.js'

export default class KanbanPlugin extends Plugin {
  settings: KanbanPluginSettings = DEFAULT_SETTINGS
  client: McpClient | null = null

  override async onload(): Promise<void> {
    await this.loadSettings()
    this.client = new McpClient({
      baseUrl: this.settings.baseUrl,
      token: this.settings.token,
    })
    console.log('[obsidiankan-mcp] loaded')
  }

  override onunload(): void {
    console.log('[obsidiankan-mcp] unloaded')
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<KanbanPluginSettings> | null
    this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings)
  }
}
