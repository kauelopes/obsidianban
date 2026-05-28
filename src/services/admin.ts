import { promises as fs } from 'node:fs'
import type { Paths } from '../config.js'
import type { TokenClaims } from '../types.js'
import { createAgentToken, type IssuedToken } from '../auth/tokens.js'
import {
  listProjects as listProjectDirs,
  loadProjectMeta,
  projectDir,
  saveProjectMeta,
} from '../vault/layout.js'
import type { CardRepository } from '../cards/repository.js'
import type { AuditLogger } from '../audit/logger.js'
import type { SSEEventBus } from '../server/sse.js'
import type { CardService } from './card.js'
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
  starter_card_id: string | null
}

export class AdminService {
  constructor(
    private readonly paths: Paths,
    private readonly cards: CardService,
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
    const dirs = await listProjectDirs(this.paths).catch(() => [])
    const out = new Set<string>()
    for (const project of dirs) {
      const meta = await loadProjectMeta(this.paths, project).catch(() => null)
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
      const meta = await loadProjectMeta(this.paths, project).catch(() => null)
      if (!meta) continue
      const archived = meta.archived === true
      if (archivedOnly) {
        if (!archived) continue
      } else if (!includeArchived) {
        if (archived) continue
      }
      projects.push({ project, columns: meta.columns, archived })
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
    const meta = await loadProjectMeta(this.paths, project).catch(() => null)
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
    const meta = await loadProjectMeta(this.paths, project).catch(() => null)
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

    // Decide *before* minting so a re-mint into a project that already has
    // tokens does not create a second starter card.
    const isFirstMint = await loadProjectMeta(this.paths, project).then(
      () => false,
      () => true,
    )

    const issued: IssuedToken = await createAgentToken(this.paths, project, actor)

    let starterCardId: string | null = null
    if (isFirstMint) {
      const card = await this.cards.create(
        {
          project,
          title: 'Agent setup — read this first',
          type: 'task',
          status: 'backlog',
          priority: 'high',
          body: starterCardBody(project, actor, issued.token_id),
          input_tokens: 0,
          output_tokens: 0,
          model: 'system:bootstrap',
        },
        claims,
      )
      starterCardId = card.id
    }

    return {
      project,
      token_id: issued.token_id,
      token: issued.raw,
      actor: issued.actor,
      created_at: issued.created_at,
      starter_card_id: starterCardId,
    }
  }
}

function starterCardBody(project: string, actor: string, tokenId: string): string {
  return [
    `Welcome to the **${project}** kanban project. This card is auto-generated`,
    `when the project is first created and exists to bootstrap the agent that`,
    `will work on this board.`,
    '',
    '## Your identity',
    '',
    `- **Project:** \`${project}\``,
    `- **Actor:** \`${actor}\``,
    `- **Token id:** \`${tokenId}\` (the raw token was shown to the manager once)`,
    '',
    '## What you can do',
    '',
    'The MCP server exposes these tools — call them via your configured',
    'transport (stdio or HTTP):',
    '',
    '- `kanban_list_cards` — see the board (your token scopes you to this project)',
    '- `kanban_get_card` — read a card including its markdown body',
    '- `kanban_create_card` — add a card to any column',
    '- `kanban_update_card` — edit fields with optimistic locking',
    '- `kanban_move_card` — change a card\'s column',
    '- `kanban_reorder_card` — change ordering within a column',
    '- `kanban_delete_card` — remove a card',
    '- `kanban_archive_card` / `kanban_unarchive_card` — hide / restore',
    '',
    'Every mutation must carry `input_tokens`, `output_tokens`, and `model`',
    'so the human can see the cost of your work. Retries should reuse the',
    'same `request_id` (UUIDv4) to stay idempotent.',
    '',
    '## Suggested first steps',
    '',
    '1. Call `kanban_list_cards` to confirm you can read the board.',
    '2. Move this card to `in-progress` to acknowledge bootstrap.',
    '3. Read any cards in `todo` — those are the work the manager prepared.',
    '4. When you finish a card, move it to `review`. The manager promotes',
    '   reviewed cards to `done`.',
    '',
    '## Conflict handling',
    '',
    'Every update takes a `version` field. If the version is stale you get a',
    '`409 conflict` with the current card embedded in the response — merge',
    'or refetch and retry. Never overwrite without reading first.',
    '',
    'Once you understand all of this, move this card to `done` and start on',
    'the real work.',
    '',
  ].join('\n')
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
