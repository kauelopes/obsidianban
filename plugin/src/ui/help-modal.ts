import { Modal, MarkdownRenderer, type App, type Component } from 'obsidian'

/**
 * Onboarding modal opened from the board's Help button. Renders the same
 * content the server used to bake into the per-project starter card before
 * we made sprint_id mandatory — there's no longer a guaranteed sprint to
 * attach a starter card to, so the onboarding lives client-side now and
 * is reachable any time, not just on first project creation.
 */
export class HelpModal extends Modal {
  constructor(app: App, private readonly host: Component) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText('ObsidianKan — agent onboarding')
    const ct = this.contentEl
    ct.addClass('kanban-mcp-help-modal')
    void MarkdownRenderer.render(this.app, HELP_BODY, ct, '/', this.host)
  }
}

const HELP_BODY = [
  'This board is backed by the ObsidianKan MCP server. The text below is',
  'the briefing an AI agent should read before working on any card.',
  '',
  '## What the agent can do',
  '',
  'The MCP server exposes these tools — call them via your configured',
  'transport (stdio or HTTP):',
  '',
  '- `kanban_list_cards` — see the board (an agent token scopes you to its project)',
  '- `kanban_get_card` — read a card including its markdown body',
  '- `kanban_create_card` — add a card to a column **(requires `sprint_id`)**',
  '- `kanban_bulk_create_cards` — create up to 100 cards in one call',
  '  (use this when parsing a PRD into a backlog so the cost is booked once;',
  '  `sprint_id` can be set once at the envelope level)',
  '- `kanban_update_card` — edit fields with optimistic locking',
  '- `kanban_move_card` — change a card\'s column',
  '- `kanban_reorder_card` — change ordering within a column',
  '- `kanban_delete_card` — remove a card',
  '- `kanban_archive_card` / `kanban_unarchive_card` — hide / restore',
  '- `kanban_claim_card` / `kanban_release_card` — take or relinquish ownership',
  '- `kanban_pick_next` — return the next ready card (no unsatisfied blockers); filter by sprint_id or assigned_to',
  '- `kanban_list_sprints` / `kanban_get_sprint` — see what sprint is active and read its goal + aggregates (use this as briefing)',
  '- `kanban_create_sprint` / `kanban_start_sprint` / `kanban_close_sprint` — manager-only sprint lifecycle',
  '- `kanban_add_to_sprint` / `kanban_move_between_sprints` — manager-only card↔sprint membership',
  '',
  'Every mutation must carry `input_tokens`, `output_tokens`, and `model`',
  'so the human can see the cost of your work. Retries should reuse the',
  'same `request_id` (UUIDv4) to stay idempotent.',
  '',
  '## Sprints are mandatory',
  '',
  'Every new card must belong to a sprint (planning or active). Before',
  'calling `kanban_create_card`, find the right sprint with',
  '`kanban_list_sprints?status=open` and pass its id in the `sprint_id`',
  'field. Cards cannot be born loose; that\'s a deliberate constraint to',
  'keep focus tied to the sprint goal.',
  '',
  '## Ownership',
  '',
  'Each card has an `assigned_to` field. Once it\'s set to an actor, only',
  'that actor (or a manager) can mutate the card — everyone else gets',
  '`403 not_assigned`. Before working on a card you don\'t own:',
  '',
  '1. Call `kanban_claim_card` — fails with `409 already_claimed` if another agent got there first.',
  '2. Do the work.',
  '3. Call `kanban_release_card` when you hand off to review, or just leave it claimed if you\'re continuing.',
  '',
  '## Suggested first steps',
  '',
  '1. Call `kanban_list_cards` to confirm you can read the board.',
  '2. Call `kanban_list_sprints?status=active` to find the current sprint.',
  '3. Call `kanban_pick_next?sprint_id=...` to find a card ready to start.',
  '4. Claim it, move it to `in-progress`, do the work, move to `review` when done.',
  '',
  '## Dependencies',
  '',
  'A card can have a `blocked_by: [card_id, ...]` field. The server will',
  'refuse to let you advance a blocked card past `todo` (you get a',
  '`409 blocked { blockers }` with the unsatisfied ids). Use',
  '`kanban_pick_next` to skip blocked cards automatically — it returns',
  'the next ready card and tells you how many candidates are still gated.',
  '',
  '## Conflict handling',
  '',
  'Every update takes a `version` field. If the version is stale you get a',
  '`409 conflict` with the current card embedded in the response — merge',
  'or refetch and retry. Never overwrite without reading first.',
  '',
].join('\n')
