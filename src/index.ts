import { loadConfig } from './config.js'
import { ensureLayout, cleanupOrphanTmpFiles } from './vault/layout.js'
import { openDatabase } from './db/database.js'

async function main(): Promise<void> {
  const config = loadConfig()
  await ensureLayout(config.paths)
  const removed = await cleanupOrphanTmpFiles(config.paths)
  if (removed > 0) {
    console.log(`[startup] removed ${removed} orphan .tmp file(s)`)
  }
  const { db, createdFromScratch } = await openDatabase(config.paths.sqlite)
  console.log(
    `[startup] vault=${config.paths.vault} sqlite=${config.paths.sqlite} ` +
      `${createdFromScratch ? 'created' : 'existing'}`,
  )
  // TODO Sprint 02: start MCP transports, file watcher, reconciliation.
  // For Sprint 01 the entry only proves the foundation pieces wire together.
  db.close()
}

main().catch((err) => {
  console.error('[fatal]', err)
  process.exit(1)
})
