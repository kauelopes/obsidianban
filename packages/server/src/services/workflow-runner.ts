import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, promises as fs } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { logger } from '../util/logger.js'
import { badRequest, conflict, notFound } from './errors.js'
import type { SSEEventBus } from '../server/sse.js'
import type { Paths } from '../config.js'
import type { WorkflowLogResult, WorkflowRunStatus, WorkflowRunView } from '@obsidiankan/types'
import { WORKFLOW_LOG_CHUNK_MAX } from '../util/constants.js'

export interface WorkflowConfig {
  scriptPath: string
  logDir: string
  /** true = kanban_start_sprint dispara o workflow sozinho (WORKFLOW_ENABLED). */
  autoLaunch: boolean
  kanbanUrl: string
}

/**
 * Config de lançamento do workflow. Diferente da versão anterior, sempre
 * retorna uma config: o disparo manual (kanban_workflow_start) funciona sem
 * nenhuma env — WORKFLOW_ENABLED controla apenas o auto-launch no start da
 * sprint. Defaults: o script dentro do próprio pacote e logs em
 * <vault>/.kanban/workflow-logs.
 */
export function loadWorkflowConfig(env: NodeJS.ProcessEnv, paths: Paths): WorkflowConfig {
  // services/ (src ou dist) → sobe 2 níveis → packages/server → scripts/
  const defaultScript = path.join(__dirname, '..', '..', 'scripts', 'sprint-workflow.ts')
  const port = Number(env['MCP_HTTP_PORT'] ?? 9375)
  return {
    scriptPath: env['WORKFLOW_SCRIPT_PATH'] ?? defaultScript,
    logDir: env['WORKFLOW_LOG_DIR'] ?? path.join(paths.vault, '.kanban', 'workflow-logs'),
    autoLaunch: env['WORKFLOW_ENABLED'] === 'true',
    kanbanUrl: `http://127.0.0.1:${port}`,
  }
}

interface Run {
  view: WorkflowRunView
  child: ChildProcess | null
  logPath: string
  /** true depois de stop() — decide entre 'stopped' e 'failed' no close. */
  stopping: boolean
}

const SPRINT_ID_RE = /^[A-Za-z0-9_-]+$/

/**
 * Gerencia execuções do sprint workflow: uma por sprint, spawnada como
 * processo detached (líder de process group, para o stop matar também os
 * harnesses dev filhos), com stdout+stderr canalizados para um log em disco.
 * O estado vive em memória — após restart do servidor o processo antigo segue
 * vivo mas órfão do tracking; o log em disco continua legível.
 */
export class WorkflowManager {
  private readonly runs = new Map<string, Run>()

  constructor(
    private readonly cfg: WorkflowConfig,
    private readonly sse: SSEEventBus,
  ) {}

  get autoLaunch(): boolean {
    return this.cfg.autoLaunch
  }

  isRunning(sprintId: string): boolean {
    return this.runs.get(sprintId)?.view.status === 'running'
  }

  status(sprintId: string): WorkflowRunView | null {
    return this.runs.get(sprintId)?.view ?? null
  }

  async start(sprintId: string, project: string, targetRepo: string): Promise<WorkflowRunView> {
    if (!SPRINT_ID_RE.test(sprintId)) throw badRequest('invalid_field', { field: 'sprint_id' })
    if (this.isRunning(sprintId)) {
      throw conflict({ error: 'workflow_already_running', sprint_id: sprintId })
    }
    for (const r of this.runs.values()) {
      if (r.view.project === project && r.view.status === 'running') {
        throw conflict({ error: 'workflow_already_running', sprint_id: r.view.sprint_id, project })
      }
    }

    const repoOk = await fs.stat(targetRepo).then((s) => s.isDirectory(), () => false)
    if (!repoOk) throw badRequest('target_repo_missing', { target_repo: targetRepo })

    const tokens = await this.resolveTokens(targetRepo)

    await fs.mkdir(this.cfg.logDir, { recursive: true })
    const logPath = path.join(this.cfg.logDir, `sprint-${sprintId}.log`)
    const out = createWriteStream(logPath, { flags: 'a' })
    out.write(`\n[${new Date().toISOString()}] ── workflow start — sprint ${sprintId} (${project}) — repo ${targetRepo}\n`)
    if (!process.env['ANTHROPIC_API_KEY']) {
      out.write(`[${new Date().toISOString()}] warn: ANTHROPIC_API_KEY ausente no ambiente do servidor — a triagem LLM vai falhar\n`)
    }

    // .ts precisa do loader tsx; um script já compilado (.js/.mjs) roda direto.
    // O loader vai como URL absoluta resolvida DAQUI: o cwd do filho é o
    // target_repo, que não tem node_modules — '--import tsx' não resolveria.
    const nodeArgs = this.cfg.scriptPath.endsWith('.ts')
      ? ['--import', pathToFileURL(require.resolve('tsx')).href, this.cfg.scriptPath]
      : [this.cfg.scriptPath]
    const child = spawn('node', nodeArgs, {
      cwd: targetRepo,
      env: {
        ...process.env,
        DEBUG_LOG: logPath,
        KANBAN_URL: this.cfg.kanbanUrl,
        TARGET_REPO: targetRepo,
        KANBAN_PM_TOKEN: tokens.pm,
        KANBAN_DEV_TOKEN: tokens.dev,
      },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.pipe(out)
    child.stderr!.pipe(out)
    child.unref()

    const view: WorkflowRunView = {
      sprint_id: sprintId,
      project,
      pid: child.pid ?? null,
      status: 'running',
      started_at: new Date().toISOString(),
      ended_at: null,
      exit_code: null,
    }
    const run: Run = { view, child, logPath, stopping: false }
    this.runs.set(sprintId, run)

    child.on('error', (err) => {
      logger.error({ err, sprint: sprintId }, 'workflow: child process error')
      this.finalize(run, 'failed', null)
    })
    child.on('close', (code) => {
      const status: WorkflowRunStatus = run.stopping ? 'stopped' : code === 0 ? 'exited' : 'failed'
      this.finalize(run, status, code)
    })

    logger.info({ sprint: sprintId, pid: child.pid, log: logPath, cwd: targetRepo }, 'workflow: launched')
    this.sse.emit({ type: 'WORKFLOW_STARTED', payload: { sprint_id: sprintId, project } })
    return view
  }

  stop(sprintId: string): WorkflowRunView {
    const run = this.runs.get(sprintId)
    if (!run) throw notFound()
    if (run.view.status !== 'running' || run.view.pid === null) {
      throw conflict({ error: 'workflow_not_running', sprint_id: sprintId, status: run.view.status })
    }
    run.stopping = true
    try {
      // pid negativo = process group inteiro (o workflow + o harness dev filho).
      process.kill(-run.view.pid, 'SIGTERM')
    } catch (err) {
      logger.warn({ err, sprint: sprintId, pid: run.view.pid }, 'workflow: kill failed — marking stopped')
      this.finalize(run, 'stopped', null)
    }
    return run.view
  }

  /**
   * Leitura incremental do log: devolve o conteúdo a partir de `offset`
   * (limitado a um chunk) e o tamanho total, que o cliente devolve como offset
   * na próxima chamada. Funciona mesmo sem run em memória (pós-restart).
   */
  async readLog(sprintId: string, offset: number): Promise<WorkflowLogResult> {
    if (!SPRINT_ID_RE.test(sprintId)) throw badRequest('invalid_field', { field: 'sprint_id' })
    const run = this.runs.get(sprintId)
    const logPath = run?.logPath ?? path.join(this.cfg.logDir, `sprint-${sprintId}.log`)

    const stat = await fs.stat(logPath).catch(() => null)
    if (!stat) {
      if (!run) throw notFound()
      return { sprint_id: sprintId, run: run.view, size: 0, data: '' }
    }

    const size = stat.size
    const from = Math.min(Math.max(0, offset), size)
    const length = Math.min(size - from, WORKFLOW_LOG_CHUNK_MAX)
    let data = ''
    if (length > 0) {
      const fh = await fs.open(logPath, 'r')
      try {
        const buf = Buffer.alloc(length)
        await fh.read(buf, 0, length, from)
        data = buf.toString('utf8')
      } finally {
        await fh.close()
      }
    }
    return { sprint_id: sprintId, run: run?.view ?? null, size: from + length, data }
  }

  private finalize(run: Run, status: WorkflowRunStatus, code: number | null): void {
    if (run.view.status !== 'running') return
    run.view.status = status
    run.view.exit_code = code
    run.view.ended_at = new Date().toISOString()
    run.child = null
    logger.info({ sprint: run.view.sprint_id, status, code }, 'workflow: finished')
    this.sse.emit({
      type: 'WORKFLOW_EXITED',
      payload: {
        sprint_id: run.view.sprint_id,
        project: run.view.project,
        status,
        exit_code: code,
      },
    })
  }

  /**
   * Os tokens pm/dev que o script exige vêm, em ordem: do
   * .claude/settings.local.json do repo alvo — onde o workflow-readiness os
   * grava ao provisionar o projeto — ou, na falta, do ambiente do servidor.
   * O settings do repo VENCE por dois motivos: os tokens são por projeto (um
   * env global estaria errado para os demais), e o ambiente do servidor pode
   * estar poluído por placeholders herdados do shell que o lançou — foi
   * exatamente assim que um "REPLACE_WITH_DEV_TOKEN" chegou ao harness dev.
   */
  private async resolveTokens(targetRepo: string): Promise<{ pm: string; dev: string }> {
    const settingsPath = path.join(targetRepo, '.claude', 'settings.local.json')
    let env: Record<string, string> = {}
    try {
      const parsed = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>
      env = (parsed['env'] as Record<string, string> | undefined) ?? {}
    } catch {
      /* settings ausente — só o fallback de ambiente resta */
    }
    const pm = env['KANBAN_TOKEN'] ?? process.env['KANBAN_PM_TOKEN']
    const dev = env['KANBAN_DEV_TOKEN'] ?? process.env['KANBAN_DEV_TOKEN']
    if (!pm || !dev) {
      throw badRequest('workflow_tokens_missing', {
        hint: 'defina o repo do projeto (kanban_set_project_repo) para provisionar os tokens em .claude/settings.local.json, ou exporte KANBAN_PM_TOKEN/KANBAN_DEV_TOKEN no ambiente do servidor',
        settings_path: settingsPath,
      })
    }
    return { pm, dev }
  }
}
