import type { Paths } from '../config.js'
import type { TokenClaims } from '../types.js'
import { createAgentToken, type IssuedToken } from '../auth/tokens.js'
import { listProjects as listProjectDirs, loadProjectMeta } from '../vault/layout.js'
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
  ) {}

  /**
   * List visible projects with their column shape. Agents only see their own
   * scoped project (so the plugin can render its columns even when there are
   * no cards yet); managers see every project in the vault. Projects with a
   * missing or unreadable _meta.json are silently skipped.
   */
  async listProjects(claims: TokenClaims): Promise<{ projects: ProjectInfo[] }> {
    if (claims.role === 'agent') {
      const meta = await loadProjectMeta(this.paths, claims.project_id).catch(() => null)
      if (!meta) return { projects: [] }
      return { projects: [{ project: claims.project_id, columns: meta.columns }] }
    }
    const dirs = await listProjectDirs(this.paths)
    const projects: ProjectInfo[] = []
    for (const project of dirs) {
      const meta = await loadProjectMeta(this.paths, project).catch(() => null)
      if (meta) projects.push({ project, columns: meta.columns })
    }
    return { projects }
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
