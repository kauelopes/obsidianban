export interface KanbanPluginSettings {
  baseUrl: string
  token: string
}

export const DEFAULT_SETTINGS: KanbanPluginSettings = {
  baseUrl: 'http://127.0.0.1:3000',
  token: '',
}
