import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import path from 'node:path'
import { logger } from '../util/logger.js'

export interface WorkflowConfig {
  scriptPath: string    // abs path to sprint-workflow.ts (or compiled .js)
  logDir: string | null // when set, per-sprint log files are written here
}

/**
 * Read workflow launch config from env. Returns null when auto-launch is
 * disabled (WORKFLOW_ENABLED != "true") or misconfigured.
 *
 * Required env vars when enabled:
 *   WORKFLOW_ENABLED=true
 *   WORKFLOW_SCRIPT_PATH   absolute path to sprint-workflow.ts
 *   WORKFLOW_LOG_DIR       dir where per-sprint .log files land (optional)
 *
 * The working directory (TARGET_REPO) must be set per-project via
 * kanban_set_project_repo — no global fallback exists.
 *
 * The spawned process inherits the full server env, so ANTHROPIC_API_KEY,
 * KANBAN_DEV_TOKEN, and KANBAN_PM_TOKEN must be present there.
 */
export function loadWorkflowConfig(env: NodeJS.ProcessEnv): WorkflowConfig | null {
  if (env['WORKFLOW_ENABLED'] !== 'true') return null
  const scriptPath = env['WORKFLOW_SCRIPT_PATH']
  if (!scriptPath) {
    logger.warn('workflow: WORKFLOW_ENABLED=true but WORKFLOW_SCRIPT_PATH not set — auto-launch disabled')
    return null
  }
  return {
    scriptPath,
    logDir: env['WORKFLOW_LOG_DIR'] ?? null,
  }
}

export class WorkflowRunner {
  constructor(private readonly cfg: WorkflowConfig) {}

  /**
   * Spawn the sprint workflow as a detached background process.
   * The process is unref'd immediately so the server can exit independently.
   * When logDir is configured, stdout+stderr are piped to
   * <logDir>/sprint-<sprintId>.log and DEBUG_LOG is set for the workflow's
   * own structured log output.
   */
  launch(sprintId: string, targetRepo: string): void {
    const args = ['--import', 'tsx', this.cfg.scriptPath]
    const baseEnv = { ...process.env }
    const cwd = targetRepo

    if (this.cfg.logDir) {
      try { mkdirSync(this.cfg.logDir, { recursive: true }) } catch { /* pre-existing */ }
      const logPath = path.join(this.cfg.logDir, `sprint-${sprintId}.log`)
      const child = spawn('node', args, {
        cwd,
        env: { ...baseEnv, DEBUG_LOG: logPath },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const out = createWriteStream(logPath, { flags: 'a' })
      child.stdout.pipe(out)
      child.stderr.pipe(out)
      child.on('error', (err) => logger.error({ err, sprint: sprintId }, 'workflow: child process error'))
      child.unref()
      logger.info({ sprint: sprintId, pid: child.pid, log: logPath, cwd }, 'workflow: launched')
    } else {
      const child = spawn('node', args, {
        cwd,
        env: baseEnv,
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', (err) => logger.error({ err, sprint: sprintId }, 'workflow: child process error'))
      child.unref()
      logger.info({ sprint: sprintId, pid: child.pid, cwd }, 'workflow: launched')
    }
  }
}
