export interface KanbanPluginSettings {
  baseUrl: string
  token: string
  /** When true, archived cards are fetched and rendered (faded). Default
   *  false — archived cards stay out of the board entirely. */
  showArchived: boolean
}

export const DEFAULT_SETTINGS: KanbanPluginSettings = {
  baseUrl: 'http://127.0.0.1:9375',
  token: '',
  showArchived: false,
}
