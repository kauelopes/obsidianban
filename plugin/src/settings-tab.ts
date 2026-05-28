import { PluginSettingTab, Setting, Notice, type App } from 'obsidian'
import type KanbanPlugin from './main.js'

export class KanbanSettingsTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: KanbanPlugin) {
    super(app, plugin)
  }

  override display(): void {
    const { containerEl } = this
    containerEl.empty()

    new Setting(containerEl)
      .setName('MCP base URL')
      .setDesc('Where the local MCP server listens (default port 3000).')
      .addText((text) =>
        text
          .setPlaceholder('http://127.0.0.1:3000')
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Project')
      .setDesc(
        'Project name to show on the board (required to create the first card). ' +
          'For agent tokens, must match the token\'s project.',
      )
      .addText((text) =>
        text
          .setPlaceholder('my-project')
          .setValue(this.plugin.settings.projectName)
          .onChange(async (value) => {
            this.plugin.settings.projectName = value.trim()
            await this.plugin.saveSettings()
          }),
      )

    new Setting(containerEl)
      .setName('Bearer token')
      .setDesc('Token issued by `npm run kanban-token create ...`. Stored locally.')
      .addText((text) => {
        text.inputEl.type = 'password'
        text
          .setPlaceholder('paste bearer token')
          .setValue(this.plugin.settings.token)
          .onChange(async (value) => {
            this.plugin.settings.token = value.trim()
            await this.plugin.saveSettings()
          })
      })

    new Setting(containerEl)
      .setName('Connection')
      .setDesc('Verify that the MCP is reachable with the current settings.')
      .addButton((btn) =>
        btn
          .setButtonText('Test connection')
          .setCta()
          .onClick(async () => {
            const client = this.plugin.client
            if (!client) {
              new Notice('Plugin not initialized')
              return
            }
            const res = await client.health()
            if (res.ok) {
              new Notice(`MCP ok — ${res.data.cards_indexed} cards indexed`)
            } else {
              new Notice(`MCP ${res.error.kind}: ${res.error.message}`)
            }
          }),
      )
  }
}
