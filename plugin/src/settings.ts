export interface KanbanPluginSettings {
  baseUrl: string
  token: string
  /** Used to render empty columns when the board has no cards yet, and as the
   *  `project` field on create requests. For agent tokens this must match the
   *  token's project_id; managers need it to address a specific project. */
  projectName: string
}

export const DEFAULT_SETTINGS: KanbanPluginSettings = {
  baseUrl: 'http://127.0.0.1:3000',
  token: '',
  projectName: '',
}
