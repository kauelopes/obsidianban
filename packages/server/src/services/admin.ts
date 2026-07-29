import { promises as fs } from 'node:fs'
import type { Paths } from '../config.js'
import type { Goal, TokenClaims, WorkflowReadinessResult } from '@obsidiankan/types'
import { createAgentToken, type IssuedToken } from '../auth/tokens.js'
import { checkWorkflowReadiness } from './workflow-readiness.js'
import { requirePmOrManager } from './guards.js'
import { generateGoalId, optString, requireString } from './validation.js'
import {
  listProjects as listProjectDirs,
  listProjectsSafe,
  loadProjectMeta,
  loadProjectMetaOrNull,
  projectDir,
  saveProjectMeta,
} from '../vault/layout.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { SSEEventBus } from '../server/sse.js'
import { badRequest, HttpError } from './errors.js'

// Project names map directly to directory names under kanban-data/, so they
// must be filesystem-safe and free of traversal.
const SAFE_PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

// Actor names are shown in audit logs and prefixed by role convention
// (agent:foo, human:bar), so `:` is allowed but slashes and dots-only are not.
const SAFE_ACTOR = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/

export interface ProjectInfo {
  project: string
  columns: string[]
  archived: boolean
  target_repo?: string
  goals?: Goal[]
}

export interface SetProjectRepoResult extends ProjectInfo {
  workflow_readiness?: WorkflowReadinessResult
}

export interface DeleteProjectResult {
  project: string
  cards_deleted: number
}

export interface CreateProjectResult {
  project: string
  token_id: string
  token: string
  actor: string
  created_at: string
  /** Presente quando veio `target_repo` — mesma forma de kanban_set_project_repo. */
  workflow_readiness?: WorkflowReadinessResult
}

export class AdminService {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {}

  /**
   * Returns the set of currently-archived project names. Consumers
   * (QueryService) use this to filter cards out of default listings so an
   * archived project disappears from the board cleanly, cards included.
   */
  async getArchivedProjects(): Promise<Set<string>> {
    const dirs = await listProjectsSafe(this.paths)
    const out = new Set<string>()
    for (const project of dirs) {
      const meta = await loadProjectMetaOrNull(this.paths, project)
      if (meta?.archived === true) out.add(project)
    }
    return out
  }

  /**
   * List visible projects with their column shape. Agents only see their own
   * scoped project (so the plugin can render its columns even when there are
   * no cards yet); managers see every project in the vault. Archived projects
   * are hidden unless `include_archived: true`; `archived_only: true` takes
   * precedence and returns only archived ones.
   */
  async listProjects(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ projects: ProjectInfo[] }> {
    const includeArchived = optBool(params, 'include_archived', false)
    const archivedOnly = optBool(params, 'archived_only', false)

    const candidates =
      claims.role === 'agent' ? [claims.project_id] : await listProjectDirs(this.paths)

    const projects: ProjectInfo[] = []
    for (const project of candidates) {
      const meta = await loadProjectMetaOrNull(this.paths, project)
      if (!meta) continue
      const archived = meta.archived === true
      if (archivedOnly) {
        if (!archived) continue
      } else if (!includeArchived) {
        if (archived) continue
      }
      projects.push({
        project,
        columns: meta.columns,
        archived,
        target_repo: meta.target_repo,
        goals: sanitizeGoals(meta.goals),
      })
    }
    return { projects }
  }

  async archiveProject(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<ProjectInfo> {
    return this.setProjectArchived(params, claims, true)
  }

  async unarchiveProject(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<ProjectInfo> {
    return this.setProjectArchived(params, claims, false)
  }

  private async setProjectArchived(
    params: Record<string, unknown>,
    claims: TokenClaims,
    target: boolean,
  ): Promise<ProjectInfo> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const project = requireMatch(params, 'project', SAFE_PROJECT, '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw new HttpError(404, { error: 'not_found', project })
    if ((meta.archived === true) === target) {
      // No-op short-circuit, matching the card archive semantics.
      return { project, columns: meta.columns, archived: target }
    }
    meta.archived = target
    await saveProjectMeta(this.paths, project, meta)
    await this.audit.log({
      ts: new Date().toISOString(),
      op: target ? 'PROJECT_ARCHIVED' : 'PROJECT_UNARCHIVED',
      project,
      actor: claims.actor,
    })
    this.sse.emit({
      type: target ? 'PROJECT_ARCHIVED' : 'PROJECT_UNARCHIVED',
      payload: { project },
    })
    return { project, columns: meta.columns, archived: target }
  }

  /**
   * Hard-delete: removes the project folder (including all card .md files
   * and the _meta.json with its tokens) and purges matching SQLite rows.
   * Manager-only. Requires `confirm` to equal the project name as an
   * accidental-deletion guard. Returns the count of card rows removed.
   */
  async deleteProject(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<DeleteProjectResult> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const project = requireMatch(params, 'project', SAFE_PROJECT, '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    const confirm = params['confirm']
    if (typeof confirm !== 'string' || confirm !== project) {
      throw badRequest('invalid_field', {
        field: 'confirm',
        reason: 'must equal the project name to confirm destructive delete',
      })
    }
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw new HttpError(404, { error: 'not_found', project })

    const cardsDeleted = this.repo.deleteByProject(project)
    await fs.rm(projectDir(this.paths, project), { recursive: true, force: true })

    await this.audit.log({
      ts: new Date().toISOString(),
      op: 'PROJECT_DELETED',
      project,
      actor: claims.actor,
      reason: `cards_deleted=${cardsDeleted}`,
    })
    this.sse.emit({ type: 'PROJECT_DELETED', payload: { project } })
    return { project, cards_deleted: cardsDeleted }
  }

  async createProject(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<CreateProjectResult> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const project = requireMatch(params, 'project', SAFE_PROJECT, '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    const actor = requireMatch(params, 'actor', SAFE_ACTOR, '[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}')
    const targetRepo = typeof params['target_repo'] === 'string' ? params['target_repo'] : undefined

    // Under the "every card belongs to a sprint" rule we no longer auto-create
    // a starter card at project mint — there's no sprint yet to attach it to.
    // The onboarding content lives in the plugin's Help button instead.
    const issued: IssuedToken = await createAgentToken(this.paths, project, actor)

    const base = {
      project,
      token_id: issued.token_id,
      token: issued.raw,
      actor: issued.actor,
      created_at: issued.created_at,
    }

    if (targetRepo === undefined) return base

    const meta = await loadProjectMeta(this.paths, project)
    meta.target_repo = targetRepo
    await saveProjectMeta(this.paths, project, meta)

    // Gravar target_repo sem provisionar deixava o projeto com cara de pronto e
    // sem nada dentro: skills ausentes, mcp.json ausente, tokens do workflow
    // inexistentes. Quem informa o repo aqui recebe o mesmo tratamento de
    // kanban_set_project_repo — é a mesma intenção declarada em outro momento.
    const workflow_readiness = await checkWorkflowReadiness(project, targetRepo, this.paths)
    return { ...base, workflow_readiness }
  }

  async setProjectRepo(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<SetProjectRepoResult> {
    if (claims.role !== 'manager') {
      throw new HttpError(403, { error: 'forbidden', reason: 'manager_required' })
    }
    const project = requireMatch(params, 'project', SAFE_PROJECT, '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    const targetRepo = params['target_repo']
    if (targetRepo !== null && typeof targetRepo !== 'string') {
      throw new HttpError(400, { error: 'invalid_field', field: 'target_repo', expected: 'string or null' })
    }
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw new HttpError(404, { error: 'not_found', project })
    if (targetRepo === null) {
      delete meta.target_repo
    } else {
      meta.target_repo = targetRepo
    }
    await saveProjectMeta(this.paths, project, meta)
    await this.audit.log({
      ts: new Date().toISOString(),
      op: 'PROJECT_REPO_SET',
      project,
      actor: claims.actor,
      reason: `target_repo=${targetRepo ?? 'cleared'}`,
    })
    const base: ProjectInfo = { project, columns: meta.columns, archived: meta.archived === true, target_repo: meta.target_repo }
    if (typeof targetRepo === 'string') {
      const workflow_readiness = await checkWorkflowReadiness(project, targetRepo, this.paths)
      return { ...base, workflow_readiness }
    }
    return base
  }

  /**
   * Upsert de meta: sem `id` cria, com `id` edita. PM edita as metas do próprio
   * projeto porque planejar médio prazo É trabalho de PM; dev não.
   */
  async setGoal(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ project: string; goal: Goal }> {
    requirePmOrManager(claims)
    const project =
      claims.role === 'agent'
        ? claims.project_id
        : requireMatch(params, 'project', SAFE_PROJECT, '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw new HttpError(404, { error: 'not_found', project })

    const goals = meta.goals ?? []
    const id = optString(params, 'id')
    const existing = id ? goals.find((g) => g.id === id) : undefined
    if (id && !existing) {
      throw new HttpError(404, { error: 'not_found', goal_id: id })
    }

    const title = existing
      ? optString(params, 'title', GOAL_TITLE_MAX) ?? existing.title
      : requireString(params, 'title', GOAL_TITLE_MAX)
    const targetDate = readTargetDate(params, existing?.target_date ?? null)
    const status = readGoalStatus(params, existing?.status ?? 'open')
    const notes = optString(params, 'notes', GOAL_NOTES_MAX) ?? existing?.notes

    const goal: Goal = {
      id: existing?.id ?? generateGoalId(),
      title,
      target_date: targetDate,
      status,
      created_at: existing?.created_at ?? new Date().toISOString(),
      ...(notes ? { notes } : {}),
    }
    meta.goals = existing ? goals.map((g) => (g.id === goal.id ? goal : g)) : [...goals, goal]
    await saveProjectMeta(this.paths, project, meta)

    await this.audit.log({
      ts: new Date().toISOString(),
      op: 'GOAL_SET',
      project,
      actor: claims.actor,
      reason: `${goal.id} ${goal.status}`,
    })
    this.sse.emit({ type: 'PROJECT_GOALS_UPDATED', payload: { project } })
    return { project, goal }
  }

  async deleteGoal(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ project: string; goal_id: string }> {
    requirePmOrManager(claims)
    const project =
      claims.role === 'agent'
        ? claims.project_id
        : requireMatch(params, 'project', SAFE_PROJECT, '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}')
    const id = requireString(params, 'id')
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw new HttpError(404, { error: 'not_found', project })
    const goals = meta.goals ?? []
    if (!goals.some((g) => g.id === id)) {
      throw new HttpError(404, { error: 'not_found', goal_id: id })
    }
    meta.goals = goals.filter((g) => g.id !== id)
    await saveProjectMeta(this.paths, project, meta)

    await this.audit.log({
      ts: new Date().toISOString(),
      op: 'GOAL_DELETED',
      project,
      actor: claims.actor,
      reason: id,
    })
    this.sse.emit({ type: 'PROJECT_GOALS_UPDATED', payload: { project } })
    return { project, goal_id: id }
  }
}

const GOAL_TITLE_MAX = 120
const GOAL_NOTES_MAX = 1000
const GOAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const GOAL_STATUSES = ['open', 'done', 'dropped'] as const

function readTargetDate(p: Record<string, unknown>, current: string | null): string | null {
  const v = p['target_date']
  if (v === undefined) return current
  if (v === null) return null
  if (typeof v !== 'string' || !GOAL_DATE_RE.test(v)) {
    throw badRequest('invalid_field', { field: 'target_date', expected: 'YYYY-MM-DD or null' })
  }
  return v
}

function readGoalStatus(p: Record<string, unknown>, current: Goal['status']): Goal['status'] {
  const v = p['status']
  if (v === undefined) return current
  if (typeof v !== 'string' || !(GOAL_STATUSES as readonly string[]).includes(v)) {
    throw badRequest('invalid_field', { field: 'status', expected: GOAL_STATUSES.join('|') })
  }
  return v as Goal['status']
}

/**
 * _meta.json é editável à mão no Obsidian: uma meta malformada não pode
 * derrubar o listProjects — some da listagem e fica no arquivo para correção.
 */
function sanitizeGoals(goals: unknown): Goal[] | undefined {
  if (!Array.isArray(goals)) return undefined
  const ok = goals
    .filter(
      (g): g is Goal =>
        typeof g === 'object' && g !== null &&
        typeof (g as Goal).id === 'string' &&
        typeof (g as Goal).title === 'string' &&
        (GOAL_STATUSES as readonly string[]).includes((g as Goal).status),
    )
    // target_date ausente numa meta escrita à mão vira null, não descarte.
    .map((g) => ({ ...g, target_date: typeof g.target_date === 'string' ? g.target_date : null }))
  return ok.length > 0 ? ok : undefined
}

function optBool(p: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = p[key]
  if (v == null) return def
  if (typeof v !== 'boolean') throw badRequest('invalid_field', { field: key, expected: 'boolean' })
  return v
}

function requireMatch(
  p: Record<string, unknown>,
  field: string,
  pattern: RegExp,
  patternStr: string,
): string {
  const v = p[field]
  if (typeof v !== 'string' || v.length === 0) {
    throw badRequest('invalid_field', { field, expected: 'string' })
  }
  if (!pattern.test(v)) {
    throw badRequest('invalid_field', { field, reason: `must match ${patternStr}` })
  }
  return v
}
