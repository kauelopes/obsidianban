import type { Paths } from '../config.js'
import type { Epic, TokenClaims } from '@obsidiankan/types'
import type { AuditLogger } from '../audit/logger.js'
import type { SSEEventBus } from '../server/sse.js'
import { loadProjectMetaOrNull, saveProjectMeta, type ProjectMeta } from '../vault/layout.js'
import { requirePmOrManager } from './guards.js'
import { generateEpicId, optString, requireString } from './validation.js'
import { badRequest, HttpError } from './errors.js'

const EPIC_NAME_MAX = 120
const EPIC_OBJECTIVE_MAX = 1000
const EPIC_STATUSES = ['open', 'done', 'dropped'] as const
const SAFE_PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/**
 * Épicos agrupam sprints sob um objetivo comum. Vivem no _meta.json, ao lado
 * de sprints e goals — mesmo molde de AdminService.setGoal. O vínculo é
 * épico → sprints (sprint_ids); a exclusividade (um sprint em no máximo um
 * épico) é validada aqui porque o Sprint não tem campo apontando para cima.
 */
export class EpicService {
  constructor(
    private readonly paths: Paths,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
  ) {}

  async createEpic(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ project: string; epic: Epic }> {
    requirePmOrManager(claims)
    const project = this.resolveProject(params, claims)
    const meta = await this.loadMeta(project)

    const name = requireString(params, 'name', EPIC_NAME_MAX)
    const objective = optString(params, 'objective', EPIC_OBJECTIVE_MAX)
    const sprintIds = readSprintIds(params, meta, null)

    const epic: Epic = {
      id: generateEpicId(),
      name,
      objective,
      status: 'open',
      sprint_ids: sprintIds ?? [],
      created_at: new Date().toISOString(),
    }
    meta.epics = [...(meta.epics ?? []), epic]
    await saveProjectMeta(this.paths, project, meta)
    await this.logAndEmit(project, claims, epic)
    return { project, epic }
  }

  async listEpics(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ project: string; epics: Epic[] }> {
    requirePmOrManager(claims)
    const project = this.resolveProject(params, claims)
    const meta = await this.loadMeta(project)
    return { project, epics: sanitizeEpics(meta.epics) }
  }

  async updateEpic(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ project: string; epic: Epic }> {
    requirePmOrManager(claims)
    const project = this.resolveProject(params, claims)
    const meta = await this.loadMeta(project)

    const id = requireString(params, 'id')
    const epics = meta.epics ?? []
    const existing = epics.find((e) => e.id === id)
    if (!existing) throw new HttpError(404, { error: 'not_found', epic_id: id })

    const name = optString(params, 'name', EPIC_NAME_MAX) ?? existing.name
    const objective =
      'objective' in params ? optString(params, 'objective', EPIC_OBJECTIVE_MAX) : existing.objective
    const status = readStatus(params, existing.status)
    const sprintIds = readSprintIds(params, meta, existing.id) ?? existing.sprint_ids

    const epic: Epic = { ...existing, name, objective, status, sprint_ids: sprintIds }
    meta.epics = epics.map((e) => (e.id === id ? epic : e))
    await saveProjectMeta(this.paths, project, meta)
    await this.logAndEmit(project, claims, epic)
    return { project, epic }
  }

  private resolveProject(params: Record<string, unknown>, claims: TokenClaims): string {
    if (claims.role === 'agent') return claims.project_id
    const v = params['project']
    if (typeof v !== 'string' || !SAFE_PROJECT.test(v)) {
      throw badRequest('invalid_field', { field: 'project', expected: 'string' })
    }
    return v
  }

  private async loadMeta(project: string): Promise<ProjectMeta> {
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw new HttpError(404, { error: 'not_found', project })
    return meta
  }

  private async logAndEmit(project: string, claims: TokenClaims, epic: Epic): Promise<void> {
    await this.audit.log({
      ts: new Date().toISOString(),
      op: 'EPIC_SET',
      project,
      actor: claims.actor,
      reason: `${epic.id} ${epic.status}`,
    })
    this.sse.emit({ type: 'PROJECT_EPICS_UPDATED', payload: { project } })
  }
}

function readStatus(p: Record<string, unknown>, current: Epic['status']): Epic['status'] {
  const v = p['status']
  if (v === undefined) return current
  if (typeof v !== 'string' || !(EPIC_STATUSES as readonly string[]).includes(v)) {
    throw badRequest('invalid_field', { field: 'status', expected: EPIC_STATUSES.join('|') })
  }
  return v as Epic['status']
}

/**
 * Valida sprint_ids: cada sprint tem de existir no projeto e não pode estar em
 * outro épico (`selfId` isenta o próprio épico durante update). Retorna null
 * quando o campo não veio no payload.
 */
function readSprintIds(
  p: Record<string, unknown>,
  meta: ProjectMeta,
  selfId: string | null,
): string[] | null {
  const v = p['sprint_ids']
  if (v === undefined) return null
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw badRequest('invalid_field', { field: 'sprint_ids', expected: 'string[]' })
  }
  const ids = v as string[]
  if (new Set(ids).size !== ids.length) {
    throw badRequest('invalid_field', { field: 'sprint_ids', reason: 'duplicate sprint ids' })
  }
  const known = new Set((meta.sprints ?? []).map((s) => s.id))
  for (const id of ids) {
    if (!known.has(id)) {
      throw badRequest('invalid_field', { field: 'sprint_ids', reason: `unknown sprint ${id}` })
    }
  }
  for (const other of meta.epics ?? []) {
    if (other.id === selfId) continue
    const clash = ids.find((id) => other.sprint_ids.includes(id))
    if (clash) {
      throw new HttpError(409, {
        error: 'conflict',
        reason: 'sprint_already_in_epic',
        sprint_id: clash,
        epic_id: other.id,
      })
    }
  }
  return ids
}

/**
 * _meta.json é editável à mão no Obsidian: um épico malformado não pode
 * derrubar a listagem — some dela e fica no arquivo para correção.
 */
export function sanitizeEpics(epics: unknown): Epic[] {
  if (!Array.isArray(epics)) return []
  return epics
    .filter(
      (e): e is Epic =>
        typeof e === 'object' && e !== null &&
        typeof (e as Epic).id === 'string' &&
        typeof (e as Epic).name === 'string' &&
        (EPIC_STATUSES as readonly string[]).includes((e as Epic).status),
    )
    .map((e) => ({
      ...e,
      objective: typeof e.objective === 'string' ? e.objective : null,
      sprint_ids: Array.isArray(e.sprint_ids)
        ? e.sprint_ids.filter((s): s is string => typeof s === 'string')
        : [],
    }))
}
