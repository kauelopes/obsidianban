import { loadConfig } from './config.js'
import { ensureLayout, cleanupOrphanTmpFiles, loadProjectMetaOrNull } from './vault/layout.js'
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
import { createAgentToken } from './auth/tokens.js'
import { McpHttpManager } from './server/mcp-http.js'
import { SprintService } from './services/sprint.js'
import { WorkflowRunner, loadWorkflowConfig } from './services/workflow-runner.js'
import path from 'node:path'
import { logger } from './util/logger.js'
import { StaticSite } from './server/static.js'
import { TOOL_SCHEMAS } from './server/tool-schemas.js'
import { TOOL_CATALOG } from './server/tool-catalog.js'
import type { ToolAccess } from './server/tool-access.js'
import type { TokenClaims } from '@obsidiankan/types'

async function main(): Promise<void> {
  const stdioMode = process.argv.includes('--stdio')
  const config = loadConfig()
  await ensureLayout(config.paths)
  const tmpRemoved = await cleanupOrphanTmpFiles(config.paths)
  if (tmpRemoved > 0) logger.info({ count: tmpRemoved }, 'startup: removed orphan .tmp files')

  const { db, createdFromScratch } = await openDatabase(config.paths.sqlite)
  const repo = new CardRepository(db)
  const writer = new AtomicWriter(config.paths, repo)
  const audit = new AuditLogger(config.paths.auditLog)

  const validator = new TokenValidator(config.paths)
  const idempotency = new IdempotencyStore(config.paths.idempotencyStore)
  await idempotency.load()

  const sse = new SSEEventBus()
  const workflowCfg = loadWorkflowConfig(process.env)
  const workflowRunner = workflowCfg ? new WorkflowRunner(workflowCfg) : null
  if (workflowCfg) logger.info({ scriptPath: workflowCfg.scriptPath }, 'workflow: auto-launch enabled')
  const cards = new CardService(config.paths, repo, writer, audit, sse)
  const metrics = new MetricsService(db)
  const admin = new AdminService(config.paths, repo, audit, sse)
  const sprints = new SprintService(config.paths, repo, writer, audit, sse)
  const queries = new QueryService(repo, config.paths, () => admin.getArchivedProjects())

  type ToolFn = (p: Record<string, unknown>, c: TokenClaims) => Promise<unknown>
  type ToolDef = { name: string; description: string; inputSchema?: Record<string, unknown>; access: ToolAccess; handler: ToolFn }

  // Handlers keyed by name. Metadata (name, access, category, description) lives
  // in TOOL_CATALOG so docs/tool_list.md can be generated from the same source.
  const handlers: Record<string, ToolFn> = {
    kanban_list_cards: async (p, c) => queries.list(p, c),
    kanban_get_card: async (p, c) => cards.get(p, c),
    kanban_create_card: async (p, c) => cards.create(p, c),
    kanban_bulk_create_cards: async (p, c) => cards.bulkCreate(p, c),
    kanban_update_card: async (p, c) => cards.update(p, c),
    kanban_update_spec: async (p, c) => cards.updateSpec(p, c),
    kanban_update_notes: async (p, c) => cards.updateNotes(p, c),
    kanban_log_on_card: async (p, c) => cards.logOnCard(p, c),
    kanban_move_card: async (p, c) => cards.move(p, c),
    kanban_reorder_card: async (p, c) => cards.reorder(p, c),
    kanban_delete_card: async (p, c) => cards.delete(p, c),
    kanban_archive_card: async (p, c) => cards.archive(p, c),
    kanban_unarchive_card: async (p, c) => cards.unarchive(p, c),
    kanban_claim_card: async (p, c) => cards.claim(p, c),
    kanban_release_card: async (p, c) => cards.release(p, c),
    kanban_pick_next: async (p, c) => cards.pickNext(p, c),
    kanban_create_project: async (p, c) => admin.createProject(p, c),
    kanban_create_agent_token: async (p, c) => {
      if (c.role !== 'manager') throw new Error('forbidden')
      const project = p['project'] as string
      const actor = p['actor'] as string
      const agent_type = (p['agent_type'] as 'pm' | 'dev' | undefined) ?? 'pm'
      const issued = await createAgentToken(config.paths, project, actor, agent_type)
      return { project, token: issued.raw, token_id: issued.token_id, actor: issued.actor, agent_type: issued.agent_type, created_at: issued.created_at }
    },
    kanban_list_projects: async (p, c) => admin.listProjects(p, c),
    kanban_archive_project: async (p, c) => admin.archiveProject(p, c),
    kanban_unarchive_project: async (p, c) => admin.unarchiveProject(p, c),
    kanban_delete_project: async (p, c) => admin.deleteProject(p, c),
    kanban_set_project_repo: async (p, c) => admin.setProjectRepo(p, c),
    kanban_create_sprint: async (p, c) => sprints.createSprint(p, c),
    kanban_start_sprint: async (p, c) => {
      const result = await sprints.startSprint(p, c)
      if (workflowRunner) {
        const meta = await loadProjectMetaOrNull(config.paths, result.project)
        if (meta?.target_repo) {
          workflowRunner.launch(result.id, meta.target_repo)
        } else {
          logger.warn(
            { sprint: result.id, project: result.project },
            'workflow: target_repo not configured — set via kanban_set_project_repo',
          )
        }
      }
      return result
    },
    kanban_list_sprints: async (p, c) => sprints.listSprints(p, c),
    kanban_get_sprint: async (p, c) => sprints.getSprint(p, c),
    kanban_add_to_sprint: async (p, c) => sprints.addToSprint(p, c),
    kanban_move_between_sprints: async (p, c) => sprints.moveBetweenSprints(p, c),
    kanban_close_sprint: async (p, c) => sprints.closeSprint(p, c),
  }

  const tools: ToolDef[] = TOOL_CATALOG.map((m) => {
    const handler = handlers[m.name]
    if (!handler) throw new Error(`no handler registered for tool ${m.name}`)
    return { name: m.name, access: m.access, inputSchema: TOOL_SCHEMAS[m.name], description: m.description, handler }
  })

  if (stdioMode) {
    const rawToken = process.env['KANBAN_MCP_TOKEN']
    const bearer = rawToken ? extractBearer(`Bearer ${rawToken}`) ?? undefined : undefined
    const result = await validator.validate(bearer)
    if (!result.ok) {
      logger.error({ reason: result.reason }, 'fatal: stdio token validation failed')
      process.exit(1)
    }
    const claims = result.claims
    const stdio = new StdioMcpServer(claims)
    for (const t of tools) stdio.registerTool(t.name, t.description, (p, c) => t.handler(p as Record<string, unknown>, c), t.inputSchema, t.access)

    const report = await reconcile(config.paths, repo, audit, { sqliteRebuilt: createdFromScratch })
    logger.info({ ...report }, 'startup: reconciliation complete')

    const watcher = new FileWatcher(config.paths, repo, writer, audit, sse)
    await watcher.start()
    logger.info({ vault: config.paths.vault, actor: claims.actor }, 'startup: stdio ready')
    await stdio.start()

    const shutdown = async (signal: string): Promise<void> => {
      logger.info({ signal }, 'shutdown signal received')
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

  const mcp = new McpHttpManager(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      access: t.access,
      handler: (p, c) => t.handler(p as Record<string, unknown>, c),
    })),
  )
  // The SPA lives beside the compiled server: dist/ is packages/server/dist,
  // so the web build is two levels up. WEB_DIST_PATH overrides for unusual
  // layouts; when nothing is built, the server runs API-only as before.
  const webRoot =
    process.env['WEB_DIST_PATH'] ?? path.resolve(__dirname, '..', '..', 'web', 'dist')
  const candidate = new StaticSite(webRoot)
  const site = (await candidate.isAvailable()) ? candidate : undefined
  if (site) logger.info({ root: webRoot }, 'static: serving web SPA')

  const httpServer = new HttpServer({ port: config.httpPort, state, validator, idempotency, sse, metrics, mcp, site })
  for (const t of tools) {
    httpServer.registerTool(t.name, (p, c) => t.handler(p as Record<string, unknown>, c))
  }
  await httpServer.start()
  logger.info({ port: config.httpPort }, 'startup: http listening')

  const report = await reconcile(config.paths, repo, audit, { sqliteRebuilt: createdFromScratch })
  state.reconciling = false
  logger.info({ ...report }, 'startup: reconciliation complete')

  const watcher = new FileWatcher(config.paths, repo, writer, audit, sse)
  await watcher.start()
  logger.info({ vault: config.paths.vault }, 'startup: vault ready')

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received')
    await watcher.stop()
    await httpServer.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.error({ err }, 'fatal error')
  process.exit(1)
})
