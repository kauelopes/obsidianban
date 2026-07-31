import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../util/logger.js'
import { GIT_LIFECYCLE_TIMEOUT_MS } from '../util/constants.js'
import type { AuditLogger } from '../audit/logger.js'
import type { SprintLifecycleContext, SprintLifecycleHook } from './sprint-hooks.js'

const run = promisify(execFile)

const MAIN_BRANCH = 'main'

function sprintBranch(sprintId: string): string {
  return `sprint/${sprintId}`
}

async function git(repo: string, args: string[]): Promise<{ stdout: string }> {
  return run('git', ['-C', repo, ...args], { timeout: GIT_LIFECYCLE_TIMEOUT_MS })
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/**
 * Cria a branch da sprint ao iniciar e commita+mescla na main ao fechar.
 * Opt-in por projeto (ProjectMeta.git_automation) — no-op se desligado ou sem
 * target_repo. Best-effort: nunca lança, quem chama (SprintService) já trata
 * hooks como fire-and-forget, mas os métodos aqui também se protegem sozinhos
 * para deixar o `git` sempre num estado limpo (sem merge pendente) mesmo em erro.
 */
export class GitLifecycleHook implements SprintLifecycleHook {
  constructor(private readonly audit: AuditLogger) {}

  async onStart(ctx: SprintLifecycleContext): Promise<void> {
    const repo = ctx.meta.target_repo
    if (!ctx.meta.git_automation || !repo) return
    const branch = sprintBranch(ctx.sprintId)

    try {
      await git(repo, ['rev-parse', '--verify', MAIN_BRANCH])
    } catch (err) {
      logger.warn({ err, repo, sprint: ctx.sprintId }, 'git-lifecycle: branch main ausente, pulando automação')
      return
    }

    await git(repo, ['checkout', MAIN_BRANCH])
    if (await branchExists(repo, branch)) {
      await git(repo, ['checkout', branch])
    } else {
      await git(repo, ['checkout', '-b', branch, MAIN_BRANCH])
    }

    await this.audit.log({
      ts: new Date().toISOString(),
      op: 'SPRINT_GIT_BRANCH_CREATED',
      project: ctx.project,
      actor: ctx.claims.actor,
      reason: `branch=${branch}`,
    })
  }

  async onClose(ctx: SprintLifecycleContext): Promise<void> {
    const repo = ctx.meta.target_repo
    if (!ctx.meta.git_automation || !repo) return
    const branch = sprintBranch(ctx.sprintId)
    if (!(await branchExists(repo, branch))) return // sprint nunca chegou a iniciar automação

    await git(repo, ['checkout', branch])
    await git(repo, ['add', '-A'])
    const staged = await git(repo, ['diff', '--cached', '--name-only'])
    if (staged.stdout.trim().length > 0) {
      await git(repo, ['commit', '-m', `sprint ${ctx.sprintId}: fecha automaticamente`])
    }

    await git(repo, ['checkout', MAIN_BRANCH])
    try {
      await git(repo, ['merge', '--no-ff', branch, '-m', `merge sprint ${ctx.sprintId}`])
      await this.audit.log({
        ts: new Date().toISOString(),
        op: 'SPRINT_GIT_MERGED',
        project: ctx.project,
        actor: ctx.claims.actor,
        reason: `branch=${branch}`,
      })
    } catch (err) {
      await git(repo, ['merge', '--abort']).catch(() => {})
      logger.warn({ err, repo, sprint: ctx.sprintId }, 'git-lifecycle: conflito de merge, resolução manual necessária')
      await this.audit.log({
        ts: new Date().toISOString(),
        op: 'SPRINT_GIT_MERGE_CONFLICT',
        project: ctx.project,
        actor: ctx.claims.actor,
        reason: `branch=${branch} — merge abortado, resolva manualmente`,
      })
    }
  }
}
