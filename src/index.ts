import { loadConfig } from './config.js'
import { ensureLayout, cleanupOrphanTmpFiles } from './vault/layout.js'
import { openDatabase } from './db/database.js'
import { CardRepository } from './cards/repository.js'
import { AtomicWriter } from './writer/atomic.js'
import { AuditLogger } from './audit/logger.js'
import { FileWatcher } from './watcher/file-watcher.js'
import { reconcile } from './startup/reconcile.js'
import { TokenValidator } from './auth/validator.js'
import { IdempotencyStore } from './server/idempotency.js'
import { HttpServer, type ServerState } from './server/http.js'
import { CardService } from './services/card.js'
import { QueryService } from './services/query.js'

async function main(): Promise<void> {
  const config = loadConfig()
  await ensureLayout(config.paths)
  const tmpRemoved = await cleanupOrphanTmpFiles(config.paths)
  if (tmpRemoved > 0) console.log(`[startup] removed ${tmpRemoved} orphan .tmp file(s)`)

  const { db, createdFromScratch } = await openDatabase(config.paths.sqlite)
  const repo = new CardRepository(db)
  const writer = new AtomicWriter(config.paths, repo)
  const audit = new AuditLogger(config.paths.auditLog)

  const state: ServerState = {
    startedAt: Date.now(),
    vaultPath: config.paths.vault,
    reconciling: true,
    db,
  }

  const validator = new TokenValidator(config.paths)
  const idempotency = new IdempotencyStore(config.paths.idempotencyStore)
  await idempotency.load()

  const httpServer = new HttpServer({ port: config.httpPort, state, validator, idempotency })
  const cards = new CardService(config.paths, repo, writer, audit)
  const queries = new QueryService(repo)
  httpServer.registerTool('kanban_list_cards', async (p, c) => queries.list(p as Record<string, unknown>, c))
  httpServer.registerTool('kanban_get_card', async (p, c) => cards.get(p as Record<string, unknown>, c))
  httpServer.registerTool('kanban_create_card', async (p, c) => cards.create(p as Record<string, unknown>, c))
  httpServer.registerTool('kanban_update_card', async (p, c) => cards.update(p as Record<string, unknown>, c))
  await httpServer.start()
  console.log(`[startup] http listening on 127.0.0.1:${config.httpPort}`)

  const report = await reconcile(config.paths, repo, audit, {
    sqliteRebuilt: createdFromScratch,
  })
  state.reconciling = false
  console.log(
    `[startup] reconciliation: scanned=${report.scanned} reconciled=${report.reconciled} ` +
      `orphans=${report.orphansRemoved} parseErrors=${report.parseErrors} ` +
      `rebuilt=${report.sqliteRebuilt}`,
  )

  const watcher = new FileWatcher(config.paths, repo, writer, audit)
  await watcher.start()
  console.log(`[startup] vault=${config.paths.vault} ready`)

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[shutdown] ${signal} received`)
    await watcher.stop()
    await httpServer.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
