import { loadConfig } from './config.js'
import { ensureLayout, cleanupOrphanTmpFiles, loadProjectMetaOrNull } from './vault/layout.js'
import { openDatabase } from './db/database.js'
import { CardRepository } from './cards/repository.js'
import { AtomicWriter } from './writer/atomic.js'
import { AuditLogger } from './audit/logger.js'
import { FileWatcher } from './watcher/file-watcher.js'
import { reconcile } from './startup/reconcile.js'
import { TokenValidator, extractBearer } from './auth/validator.js'
import { mintSessionToken } from './auth/session.js'
import { IdempotencyStore } from './server/idempotency.js'
import { HttpServer, type ServerState } from './server/http.js'
import { SSEEventBus } from './server/sse.js'
import { StdioMcpServer } from './server/stdio.js'
import { CardService } from './services/card.js'
import { QueryService } from './services/query.js'
import { HistoryService } from './services/history.js'
import { SupervisionService } from './services/supervision.js'
import { MetricsService } from './services/metrics.js'
import { TerminalUsageService } from './services/terminal-usage.js'
import { ActivityService } from './services/activity.js'
import { DigestService } from './services/digest.js'
import { FlowService } from './services/flow.js'
import { GitActivityService } from './services/git-activity.js'
import { AdminService } from './services/admin.js'
import { EpicService } from './services/epic.js'
import { PlanningService } from './services/planning.js'
import { PlanningSessionStore } from './planning/session.js'
import { ClaudeRunner, DEFAULT_TURN_TIMEOUT_MS } from './planning/claude-runner.js'
import { StubRunner } from './planning/stub-runner.js'
import { createMaterializer } from './planning/materialize.js'
import { createStubMaterializer } from './planning/stub-materialize.js'
import { SprintPlanningSessionStore } from './sprint-planning/session.js'
import { SprintStubRunner } from './sprint-planning/stub-runner.js'
import { createSprintMaterializer } from './sprint-planning/materialize.js'
import { createStubSprintMaterializer } from './sprint-planning/stub-materialize.js'
import { SprintPlanningService } from './services/sprint-planning.js'
import { createAgentToken } from './auth/tokens.js'
import { McpHttpManager } from './server/mcp-http.js'
import { SprintService } from './services/sprint.js'
import { GitLifecycleHook } from './services/git-lifecycle-hook.js'
import { WorkflowManager, loadWorkflowConfig } from './services/workflow-runner.js'
import { JobManager, loadJobConfig } from './services/job-runner.js'
import { JobStore } from './jobs/store.js'
import { createJobToolHandlers } from './server/job-tools.js'
import { badRequest, conflict } from './services/errors.js'
import path from 'node:path'
import { logger } from './util/logger.js'
import { StaticSite } from './server/static.js'
import { TOOL_SCHEMAS } from './server/tool-schemas.js'
import { TOOL_CATALOG } from './server/tool-catalog.js'
import type { ToolAccess } from './server/tool-access.js'
import type { ManagerToken, TokenClaims } from '@obsidiankan/types'

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
  // Sessão do navegador: só existe enquanto este processo viver, e o SPA a
  // recebe injetada no index.html. Nada disso toca o vault.
  const session = mintSessionToken()
  validator.useSession(session)
  const idempotency = new IdempotencyStore(config.paths.idempotencyStore)
  await idempotency.load()

  const sse = new SSEEventBus()
  const workflowCfg = loadWorkflowConfig(process.env, config.paths)
  const workflow = new WorkflowManager(workflowCfg, sse, config.paths)
  if (workflowCfg.autoLaunch) logger.info({ scriptPath: workflowCfg.scriptPath }, 'workflow: auto-launch enabled')
  const cards = new CardService(config.paths, repo, writer, audit, sse)
  // Jobs de longa duração — instanciado logo após o WorkflowManager (ordem
  // deliberada); a reidratação (jobs.init()) roda no boot, após o reconcile.
  const jobCfg = loadJobConfig(process.env, config.paths)
  const jobStore = new JobStore(config.paths)
  const jobs = new JobManager(jobCfg, jobStore, cards, sse, audit, workflow, config.paths)
  const metrics = new MetricsService(db)
  const terminalUsage = new TerminalUsageService(db, config.paths)
  const activity = new ActivityService(db, config.paths, new GitActivityService())
  const admin = new AdminService(config.paths, repo, audit, sse)
  const epics = new EpicService(config.paths, audit, sse)
  const gitLifecycleHook = new GitLifecycleHook(audit)
  const sprints = new SprintService(config.paths, repo, writer, audit, sse, [gitLifecycleHook])

  // Claims para ações disparadas pelo próprio servidor (avanço de fila,
  // auto-close), sem token emitido — role manager satisfaz os guards dos
  // métodos de SprintService por igual.
  const SYSTEM_CLAIMS: ManagerToken = { role: 'manager', actor: 'system:auto-sprint' }

  /**
   * Mesmo bloco de auto-launch que já existia só em kanban_start_sprint,
   * reaproveitado para quando a fila avança uma sprint sozinha (fechamento
   * manual ou automático) — best-effort: falhar aqui não desfaz o que já
   * ativou.
   */
  async function autoLaunchWorkflowForStartedNext(
    started?: { sprint_id: string; project: string },
  ): Promise<void> {
    if (!started || !workflow.autoLaunch) return
    const meta = await loadProjectMetaOrNull(config.paths, started.project)
    if (!meta?.target_repo) {
      logger.warn(
        { sprint: started.sprint_id, project: started.project },
        'workflow: target_repo not configured — set via kanban_set_project_repo',
      )
      return
    }
    await workflow.start(started.sprint_id, started.project, meta.target_repo).catch((err) => {
      logger.warn({ err, sprint: started.sprint_id }, 'workflow: auto-launch falhou para sprint da fila')
    })
  }

  // Toda vez que uma execução termina (saída normal, crash ou stop), checa se
  // a sprint pode fechar sozinha (100% dos cards em done) e, se fechar e isso
  // ativar a próxima sprint da fila, dispara o workflow dela também.
  workflow.setOnFinished((view) => {
    void sprints
      .autoCloseIfComplete(view.sprint_id, SYSTEM_CLAIMS)
      .then((result) => autoLaunchWorkflowForStartedNext(result?.started_next))
      .catch((err) => logger.warn({ err, sprint: view.sprint_id }, 'sprint: checagem de auto-close falhou'))
  })
  const planningStore = new PlanningSessionStore(config.paths)
  const planningModel = process.env['PLANNING_MODEL']
  const planningStub = process.env['PLANNING_STUB'] === 'true' || process.env['PLANNING_STUB'] === '1'
  if (planningStub) logger.warn('planning: PLANNING_STUB ativo — turnos sintéticos, sem LLM')
  const planningRunner = planningStub
    ? new StubRunner()
    : new ClaudeRunner({
        cwd: planningStore.baseDir,
        ...(planningModel ? { model: planningModel } : {}),
        timeoutMs: Number(process.env['PLANNING_TURN_TIMEOUT_MS'] ?? DEFAULT_TURN_TIMEOUT_MS),
      })
  const planningModelLabel = planningStub ? 'stub' : (planningModel ?? 'claude-headless')
  const planning = new PlanningService(
    planningStore,
    planningRunner,
    repo,
    sse,
    planningModelLabel,
    planningStub
      ? createStubMaterializer()
      : createMaterializer({
          paths: config.paths,
          admin,
          sprints,
          cards,
          epics,
          modelLabel: planningModelLabel,
          saveSession: (s) => planningStore.save(s),
        }),
  )

  const sprintPlanningStore = new SprintPlanningSessionStore(config.paths)
  const sprintPlanningRunner = planningStub
    ? new SprintStubRunner()
    : new ClaudeRunner({
        cwd: sprintPlanningStore.baseDir,
        ...(planningModel ? { model: planningModel } : {}),
        timeoutMs: Number(process.env['PLANNING_TURN_TIMEOUT_MS'] ?? DEFAULT_TURN_TIMEOUT_MS),
      })
  const sprintPlanning = new SprintPlanningService(
    config.paths,
    sprintPlanningStore,
    sprintPlanningRunner,
    repo,
    sse,
    planningModelLabel,
    sprints,
    planningStub
      ? createStubSprintMaterializer()
      : createSprintMaterializer({
          sprints,
          cards,
          modelLabel: planningModelLabel,
          saveSession: (s) => sprintPlanningStore.save(s),
        }),
  )
  const queries = new QueryService(repo, config.paths, () => admin.getArchivedProjects())
  const history = new HistoryService(config.paths)
  // JobManager real injetado: distingue "job vivo" de card preso em job morto.
  const supervision = new SupervisionService(config.paths, repo, jobs)
  const digest = new DigestService(config.paths, repo, metrics, activity, supervision)
  const flow = new FlowService(config.paths, metrics)

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
    kanban_get_card_history: async (p, c) => history.getCardHistory(p, c),
    kanban_list_escalations: async (p, c) => supervision.listEscalations(p, c),
    kanban_claim_card: async (p, c) => cards.claim(p, c),
    kanban_release_card: async (p, c) => cards.release(p, c),
    kanban_defer_card: async (p, c) => cards.deferCard(p, c),
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
    kanban_set_git_automation: async (p, c) => admin.setGitAutomation(p, c),
    kanban_set_goal: async (p, c) => admin.setGoal(p, c),
    kanban_delete_goal: async (p, c) => admin.deleteGoal(p, c),
    kanban_planning_start: async (p, c) => planning.start(p, c),
    kanban_planning_get: async (p, c) => planning.get(p, c),
    kanban_planning_answer: async (p, c) => planning.answer(p, c),
    kanban_planning_refine: async (p, c) => planning.refine(p, c),
    kanban_planning_retry: async (p, c) => planning.retry(p, c),
    kanban_planning_finalize: async (p, c) => planning.finalize(p, c),
    kanban_planning_cancel: async (p, c) => planning.cancel(p, c),
    kanban_planning_list: async (p, c) => planning.list(p, c),
    kanban_sprint_planning_start: async (p, c) => sprintPlanning.start(p, c),
    kanban_sprint_planning_get: async (p, c) => sprintPlanning.get(p, c),
    kanban_sprint_planning_answer: async (p, c) => sprintPlanning.answer(p, c),
    kanban_sprint_planning_refine: async (p, c) => sprintPlanning.refine(p, c),
    kanban_sprint_planning_retry: async (p, c) => sprintPlanning.retry(p, c),
    kanban_sprint_planning_finalize: async (p, c) => sprintPlanning.finalize(p, c),
    kanban_sprint_planning_cancel: async (p, c) => sprintPlanning.cancel(p, c),
    kanban_sprint_planning_list: async (p, c) => sprintPlanning.list(p, c),
    kanban_create_epic: async (p, c) => epics.createEpic(p, c),
    kanban_list_epics: async (p, c) => epics.listEpics(p, c),
    kanban_update_epic: async (p, c) => epics.updateEpic(p, c),
    kanban_create_sprint: async (p, c) => sprints.createSprint(p, c),
    kanban_start_sprint: async (p, c) => {
      const result = await sprints.startSprint(p, c)
      await autoLaunchWorkflowForStartedNext({ sprint_id: result.id, project: result.project })
      return result
    },
    kanban_workflow_start: async (p, c) => {
      const sprintId = String(p['sprint_id'] ?? '')
      const { sprint, project } = await sprints.getSprint({ sprint_id: sprintId }, c)
      if (sprint.status !== 'active') throw conflict({ error: 'sprint_not_active', status: sprint.status })
      const meta = await loadProjectMetaOrNull(config.paths, project)
      if (!meta?.target_repo) {
        throw badRequest('target_repo_not_set', { hint: 'defina com kanban_set_project_repo antes de executar o workflow' })
      }
      return workflow.start(sprintId, project, meta.target_repo)
    },
    kanban_workflow_stop: async (p, c) => {
      const sprintId = String(p['sprint_id'] ?? '')
      // getSprint valida a visibilidade (agente só enxerga o próprio projeto).
      await sprints.getSprint({ sprint_id: sprintId }, c)
      return workflow.stop(sprintId)
    },
    kanban_workflow_request_stop: async (p, c) => {
      const sprintId = String(p['sprint_id'] ?? '')
      await sprints.getSprint({ sprint_id: sprintId }, c)
      return workflow.requestGracefulStop(sprintId)
    },
    kanban_log_workflow_usage: async (p, c) => sprints.logWorkflowUsage(p, c),
    kanban_workflow_status: async (p, c) => {
      const sprintId = String(p['sprint_id'] ?? '')
      await sprints.getSprint({ sprint_id: sprintId }, c)
      return { sprint_id: sprintId, run: workflow.status(sprintId) }
    },
    // kanban_start_job / kanban_get_job / kanban_list_jobs / kanban_stop_job —
    // handlers em server/job-tools.ts (contrato de start testável isolado).
    ...createJobToolHandlers({ paths: config.paths, cards, jobs }),
    kanban_list_sprints: async (p, c) => sprints.listSprints(p, c),
    kanban_get_sprint: async (p, c) => sprints.getSprint(p, c),
    kanban_add_to_sprint: async (p, c) => sprints.addToSprint(p, c),
    kanban_move_between_sprints: async (p, c) => sprints.moveBetweenSprints(p, c),
    kanban_close_sprint: async (p, c) => {
      const result = await sprints.closeSprint(p, c)
      await autoLaunchWorkflowForStartedNext(result.started_next)
      return result
    },
    kanban_queue_sprint: async (p, c) => sprints.enqueueSprint(p, c),
    kanban_dequeue_sprint: async (p, c) => sprints.dequeueSprint(p, c),
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
    // Reidratação de jobs após o reconcile (readota pids vivos, finaliza
    // 'lost' os mortos, refaz hand-backs interrompidos). Nunca derruba o boot.
    await jobs.init()

    const watcher = new FileWatcher(config.paths, repo, writer, audit, sse)
    await watcher.start()
    logger.info({ vault: config.paths.vault, actor: claims.actor }, 'startup: stdio ready')
    await stdio.start()

    const shutdown = async (signal: string): Promise<void> => {
      logger.info({ signal }, 'shutdown signal received')
      // Drena finalizes em voo antes de fechar o db — jobs seguem rodando.
      await jobs.dispose()
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

  const httpServer = new HttpServer({ port: config.httpPort, host: config.host, state, validator, idempotency, sse, metrics, terminalUsage, activity, digest, flow, mcp, site, session, workflow, cardsRepo: repo, paths: config.paths, jobManager: jobs })
  for (const t of tools) {
    httpServer.registerTool(t.name, (p, c) => t.handler(p as Record<string, unknown>, c))
  }
  await httpServer.start()
  logger.info({ port: config.httpPort, host: config.host }, 'startup: http listening')

  const report = await reconcile(config.paths, repo, audit, { sqliteRebuilt: createdFromScratch })
  state.reconciling = false
  logger.info({ ...report }, 'startup: reconciliation complete')
  // Reidratação de jobs após o reconcile (readota pids vivos, finaliza 'lost'
  // os mortos, refaz hand-backs interrompidos). Nunca derruba o boot.
  await jobs.init()

  const watcher = new FileWatcher(config.paths, repo, writer, audit, sse)
  await watcher.start()
  logger.info({ vault: config.paths.vault }, 'startup: vault ready')

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'shutdown signal received')
    // Drena finalizes em voo antes de fechar o db — jobs seguem rodando.
    await jobs.dispose()
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
