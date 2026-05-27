import { loadConfig } from './config.js'
import { ensureLayout, cleanupOrphanTmpFiles } from './vault/layout.js'
import { openDatabase } from './db/database.js'
import { CardRepository } from './cards/repository.js'
import { AtomicWriter } from './writer/atomic.js'
import { AuditLogger } from './audit/logger.js'
import { FileWatcher } from './watcher/file-watcher.js'
import { reconcile } from './startup/reconcile.js'

async function main(): Promise<void> {
  const config = loadConfig()
  await ensureLayout(config.paths)
  const tmpRemoved = await cleanupOrphanTmpFiles(config.paths)
  if (tmpRemoved > 0) {
    console.log(`[startup] removed ${tmpRemoved} orphan .tmp file(s)`)
  }

  const { db, createdFromScratch } = await openDatabase(config.paths.sqlite)
  const repo = new CardRepository(db)
  const writer = new AtomicWriter(config.paths, repo)
  const audit = new AuditLogger(config.paths.auditLog)

  const report = await reconcile(config.paths, repo, audit, {
    sqliteRebuilt: createdFromScratch,
  })
  console.log(
    `[startup] reconciliation: scanned=${report.scanned} reconciled=${report.reconciled} ` +
      `orphans=${report.orphansRemoved} parseErrors=${report.parseErrors} ` +
      `rebuilt=${report.sqliteRebuilt}`,
  )

  const watcher = new FileWatcher(config.paths, repo, writer, audit)
  await watcher.start()
  console.log(
    `[startup] vault=${config.paths.vault} sqlite=${config.paths.sqlite} ` +
      `port=${config.httpPort} ready`,
  )

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[shutdown] ${signal} received`)
    await watcher.stop()
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
