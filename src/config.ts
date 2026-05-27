import path from 'node:path'

export interface Paths {
  vault: string
  kanbanData: string
  kanbanInternal: string
  sqlite: string
  auditLog: string
  idempotencyStore: string
  managerTokens: string
}

export interface Config {
  paths: Paths
  httpPort: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const vault = env.VAULT_PATH
  if (!vault) {
    throw new Error('VAULT_PATH is required')
  }
  return {
    paths: pathsFor(vault),
    httpPort: Number(env.MCP_HTTP_PORT ?? 3000),
    logLevel: (env.LOG_LEVEL as Config['logLevel']) ?? 'info',
  }
}

export function pathsFor(vault: string): Paths {
  const kanbanData = path.join(vault, '.kanban-data')
  const kanbanInternal = path.join(vault, '.kanban')
  return {
    vault,
    kanbanData,
    kanbanInternal,
    sqlite: path.join(kanbanInternal, 'db.sqlite'),
    auditLog: path.join(kanbanInternal, 'audit.ndjson'),
    idempotencyStore: path.join(kanbanInternal, 'idempotency.json'),
    managerTokens: path.join(kanbanInternal, 'manager-tokens.json'),
  }
}
