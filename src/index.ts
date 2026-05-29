import { loadConfig } from './config.js'
import { ensureLayout, cleanupOrphanTmpFiles } from './vault/layout.js'
import { openDatabase } from './db/database.js'
import { CardRepository } from './cards/repository.js'
import { AtomicWriter } from './writer/atomic.js'
import { AuditLogger } from './audit/logger.js'
import { FileWatcher } from './watcher/file-watcher.js'
import { reconcile } from './startup/reconcile.js'
import { TokenValidator, extractBearer } from './auth/validator.js'
import { IdempotencyStore } from './server/idempotency.js'
import { HttpServer, type ServerState } from './server/http.js'
import { SSEEventBus } from './server/sse.js'
import { StdioMcpServer } from './server/stdio.js'
import { CardService } from './services/card.js'
import { QueryService } from './services/query.js'
import { MetricsService } from './services/metrics.js'
import { AdminService } from './services/admin.js'
import { SprintService } from './services/sprint.js'
import type { TokenClaims } from './types.js'

async function main(): Promise<void> {
  const stdioMode = process.argv.includes('--stdio')
  const config = loadConfig()
  await ensureLayout(config.paths)
  const tmpRemoved = await cleanupOrphanTmpFiles(config.paths)
  if (tmpRemoved > 0) console.error(`[startup] removed ${tmpRemoved} orphan .tmp file(s)`)

  const { db, createdFromScratch } = await openDatabase(config.paths.sqlite)
  const repo = new CardRepository(db)
  const writer = new AtomicWriter(config.paths, repo)
  const audit = new AuditLogger(config.paths.auditLog)

  const validator = new TokenValidator(config.paths)
  const idempotency = new IdempotencyStore(config.paths.idempotencyStore)
  await idempotency.load()

  const sse = new SSEEventBus()
  const cards = new CardService(config.paths, repo, writer, audit, sse)
  const metrics = new MetricsService(db)
  const admin = new AdminService(config.paths, cards, repo, audit, sse)
  const sprints = new SprintService(config.paths, repo, writer, audit, sse)
  const queries = new QueryService(repo, () => admin.getArchivedProjects())

  type ToolFn = (p: Record<string, unknown>, c: TokenClaims) => Promise<unknown>
  const tools: Array<{ name: string; description: string; handler: ToolFn }> = [
    { name: 'kanban_list_cards', description: 'List cards in the project, with optional filters', handler: async (p, c) => queries.list(p, c) },
    { name: 'kanban_get_card', description: 'Get a card by id including body', handler: async (p, c) => cards.get(p, c) },
    { name: 'kanban_create_card', description: 'Create a new card', handler: async (p, c) => cards.create(p, c) },
    { name: 'kanban_bulk_create_cards', description: 'Create up to 100 cards in one call (partial success); envelope-level token cost is prorated', handler: async (p, c) => cards.bulkCreate(p, c) },
    { name: 'kanban_update_card', description: 'Update fields of an existing card (optimistic locking)', handler: async (p, c) => cards.update(p, c) },
    { name: 'kanban_move_card', description: 'Move a card to another column', handler: async (p, c) => cards.move(p, c) },
    { name: 'kanban_reorder_card', description: 'Reorder a card within its column', handler: async (p, c) => cards.reorder(p, c) },
    { name: 'kanban_delete_card', description: 'Delete a card (optimistic locking)', handler: async (p, c) => cards.delete(p, c) },
    { name: 'kanban_archive_card', description: 'Archive a card so it stops appearing in default listings', handler: async (p, c) => cards.archive(p, c) },
    { name: 'kanban_unarchive_card', description: 'Restore an archived card to the default listing', handler: async (p, c) => cards.unarchive(p, c) },
    { name: 'kanban_claim_card', description: 'Claim an unassigned card for the caller; 409 already_claimed if held by another agent', handler: async (p, c) => cards.claim(p, c) },
    { name: 'kanban_release_card', description: 'Release a card you currently own so another agent can claim it', handler: async (p, c) => cards.release(p, c) },
    { name: 'kanban_pick_next', description: 'Return the next card ready to work on (no unsatisfied blockers); filters by sprint_id, assigned_to, status', handler: async (p, c) => cards.pickNext(p, c) },
    { name: 'kanban_create_project', description: 'Manager-only — create a project folder and mint an agent token for it', handler: async (p, c) => admin.createProject(p, c) },
    { name: 'kanban_list_projects', description: 'List projects visible to the caller; supports include_archived / archived_only filters', handler: async (p, c) => admin.listProjects(p, c) },
    { name: 'kanban_archive_project', description: 'Manager-only — hide a project (and its cards) from default listings', handler: async (p, c) => admin.archiveProject(p, c) },
    { name: 'kanban_unarchive_project', description: 'Manager-only — restore a previously archived project', handler: async (p, c) => admin.unarchiveProject(p, c) },
    { name: 'kanban_delete_project', description: 'Manager-only — permanently delete a project, its cards, and its tokens (requires confirm=<project>)', handler: async (p, c) => admin.deleteProject(p, c) },
    { name: 'kanban_create_sprint', description: 'Manager-only — create a sprint for a project (name + optional goal text)', handler: async (p, c) => sprints.createSprint(p, c) },
    { name: 'kanban_list_sprints', description: 'List sprints visible to the caller; filter by status: active|closed|all', handler: async (p, c) => sprints.listSprints(p, c) },
    { name: 'kanban_get_sprint', description: 'Get a sprint with its current member cards and aggregates (cards by status, total tokens)', handler: async (p, c) => sprints.getSprint(p, c) },
    { name: 'kanban_add_to_sprint', description: 'Manager-only — attach cards to a sprint; optionally move_to_todo to start them', handler: async (p, c) => sprints.addToSprint(p, c) },
    { name: 'kanban_remove_from_sprint', description: 'Manager-only — detach cards from a sprint without changing their column', handler: async (p, c) => sprints.removeFromSprint(p, c) },
    { name: 'kanban_close_sprint', description: 'Manager-only — close a sprint; optionally rollover_to=<sprint_id|null> for unfinished cards', handler: async (p, c) => sprints.closeSprint(p, c) },
  ]

  if (stdioMode) {
    const rawToken = process.env['KANBAN_MCP_TOKEN']
    const bearer = rawToken ? extractBearer(`Bearer ${rawToken}`) ?? undefined : undefined
    const result = await validator.validate(bearer)
    if (!result.ok) {
      console.error(`[fatal] stdio: token validation failed (${result.reason})`)
      process.exit(1)
    }
    const claims = result.claims
    const stdio = new StdioMcpServer(claims)
    for (const t of tools) stdio.registerTool(t.name, t.description, (p, c) => t.handler(p as Record<string, unknown>, c))

    const report = await reconcile(config.paths, repo, audit, { sqliteRebuilt: createdFromScratch })
    console.error(
      `[startup] reconciliation: scanned=${report.scanned} reconciled=${report.reconciled} ` +
        `orphans=${report.orphansRemoved} parseErrors=${report.parseErrors} rebuilt=${report.sqliteRebuilt}`,
    )

    const watcher = new FileWatcher(config.paths, repo, writer, audit, sse)
    await watcher.start()
    console.error(`[startup] stdio: vault=${config.paths.vault} actor=${claims.actor} ready`)
    await stdio.start()

    const shutdown = async (signal: string): Promise<void> => {
      console.error(`[shutdown] ${signal} received`)
      await watcher.stop()
      db.close()
      process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))
    return
  }

  const state: ServerState = {
    startedAt: Date.now(),
    vaultPath: config.paths.vault,
    reconciling: true,
    db,
  }

  const httpServer = new HttpServer({ port: config.httpPort, state, validator, idempotency, sse, metrics })
  for (const t of tools) {
    httpServer.registerTool(t.name, (p, c) => t.handler(p as Record<string, unknown>, c))
  }
  await httpServer.start()
  console.log(`[startup] http listening on 127.0.0.1:${config.httpPort}`)

  const report = await reconcile(config.paths, repo, audit, { sqliteRebuilt: createdFromScratch })
  state.reconciling = false
  console.log(
    `[startup] reconciliation: scanned=${report.scanned} reconciled=${report.reconciled} ` +
      `orphans=${report.orphansRemoved} parseErrors=${report.parseErrors} rebuilt=${report.sqliteRebuilt}`,
  )

  const watcher = new FileWatcher(config.paths, repo, writer, audit, sse)
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
