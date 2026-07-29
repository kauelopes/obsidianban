import { Markdown } from '../markdown/Markdown.js'

/**
 * Briefing do agente.
 *
 * Portado do `help-modal` do plugin, que era a única superfície onde esse texto
 * existia — ele nasceu porque o servidor deixou de criar card inicial quando
 * `sprint_id` virou obrigatório, e a orientação foi para o cliente.
 *
 * O corpo segue em inglês de propósito: é o que se cola no prompt de um agente,
 * e as tools têm nome em inglês. A moldura da página acompanha o resto da
 * interface.
 *
 * Está atualizado para o estado de hoje — as três zonas do card, o `log_kind`
 * e as tools de supervisão não existiam quando o texto do plugin foi escrito.
 */
export function Help() {
  return (
    <div className="detail">
      <div className="detail-inner">
        <div className="detail-head">
          <h1>Briefing do agente</h1>
          <div className="detail-ident">
            <span>o que um agente lê antes de tocar num card</span>
            <span className="sep">│</span>
            <span>em inglês de propósito — é o texto que se cola no prompt do agente</span>
          </div>
        </div>
        <Markdown prose>{BRIEFING}</Markdown>
      </div>
    </div>
  )
}

const BRIEFING = `This board is backed by the ObsidianKan MCP server. The text below is the briefing an AI agent should read before working on any card.

## The card has three zones

A card body is split into three sections, and each has an owner:

- \`# Spec\` — what to do. Written by the human or the PM agent. A dev agent reads it and does **not** rewrite it (\`kanban_update_spec\`).
- \`# Notes\` — human scratch space. Agents do not touch it (\`kanban_update_notes\`).
- \`# Agent Log\` — append-only. Every agent entry lands here, timestamped (\`kanban_log_on_card\`).

Writing outside your zone is how context gets destroyed. Respect the split.

## What the agent can do

- \`kanban_list_cards\` — see the board (an agent token scopes you to its project)
- \`kanban_get_card\` — read a card including its markdown body
- \`kanban_create_card\` — add a card to a column **(requires \`sprint_id\`)**
- \`kanban_bulk_create_cards\` — create up to 100 cards in one call (use this when parsing a PRD into a backlog so the cost is booked once)
- \`kanban_update_card\` — edit fields with optimistic locking
- \`kanban_update_spec\` / \`kanban_update_notes\` — replace one zone without touching the others
- \`kanban_log_on_card\` — append to the Agent Log
- \`kanban_move_card\` — change a card's column
- \`kanban_reorder_card\` — change ordering within a column
- \`kanban_delete_card\`, \`kanban_archive_card\`, \`kanban_unarchive_card\`
- \`kanban_claim_card\` / \`kanban_release_card\` — take or relinquish ownership
- \`kanban_pick_next\` — the next ready card (no unsatisfied blockers)
- \`kanban_list_sprints\` / \`kanban_get_sprint\` — what sprint is active, its goal and aggregates; read this as briefing
- \`kanban_get_card_history\` — full mutation history from the audit log (pm and manager)
- \`kanban_list_escalations\` — what is waiting on a human decision (pm and manager)
- \`kanban_create_sprint\`, \`kanban_start_sprint\`, \`kanban_close_sprint\` — manager-only lifecycle
- \`kanban_add_to_sprint\`, \`kanban_move_between_sprints\` — manager-only membership

Every mutation must carry \`input_tokens\`, \`output_tokens\` and \`model\` so the human can see the cost of your work. Do not invent these numbers — omit them if you do not know them. Retries should reuse the same \`request_id\` (UUIDv4) to stay idempotent.

## Escalating

When you are blocked or want to propose something, log it (\`log_kind: 'escalate'\` is recommended for clarity, but not required) and move the card to \`review\`. Moving to \`review\` is what puts it in \`kanban_list_escalations\` and the human's inbox — **not** a specific log tag. Do **not** write \`[ESCALATE]\` in the text — it used to be the convention, it is not read anymore.

A card in \`review\` is not handed straight to a human. It first goes through PM triage — automated when a sprint workflow is running, or a human PM otherwise — which resolves it one of three ways: **CLOSE** (genuinely done → \`done\`), **RETURN** (the blocker is fixable, so the PM fixes it and sends the card back to \`todo\` for the dev agent to continue), or **FOLLOW-UP** (the proposal becomes a new card, and the original resolves as \`done\` or \`todo\`). A card only stays visible in the human inbox if none of those apply yet.

A PM answering an escalation logs with \`log_kind: 'pm_resolved'\` **and** moves the card off \`review\` (to \`done\` or \`todo\`) — logging alone does not remove it from the inbox, only leaving \`review\` does.

\`\`\`mermaid
flowchart TD
    DEV["Dev agent: blocked or proposing something<br/>kanban_log_on_card + kanban_move_card → review"] --> REVIEW{{"Card in review"}}

    REVIEW --> DET{"Deterministic check:<br/>all blocked_by cards done?"}
    DET -->|yes| AUTORETURN["Release claim, move → todo<br/>(no LLM call needed)"]
    AUTORETURN --> TODO(["todo — dev agent picks it up again"])

    DET -->|no| TRIAGE["PM triage reads the # Agent Log<br/>(automated LLM during a sprint run,<br/>or a human PM in the Escalações inbox)"]

    TRIAGE -->|"CLOSE: genuinely done"| DONE(["done"])
    TRIAGE -->|"RETURN: PM can fix the blocker itself<br/>(more tools/access than the dev)"| RETURN["Fix it (e.g. clear blocked_by),<br/>log pm_resolved, move → todo"]
    RETURN --> TODO
    TRIAGE -->|"FOLLOW-UP: dev proposed new work"| FOLLOWUP["kanban_create_card for the proposal,<br/>then resolve the original (done or todo)"]
    FOLLOWUP --> DONE
    FOLLOWUP --> TODO

    TRIAGE -->|"none of the above fit yet"| INBOX["Stays in review —<br/>visible in kanban_list_escalations<br/>and the web Escalações tab"]
    INBOX -.->|"human resolves,<br/>same CLOSE/RETURN outcomes"| TRIAGE
\`\`\`

## Sprints are mandatory

Every new card must belong to a sprint (planning or active). Before calling \`kanban_create_card\`, find the right sprint with \`kanban_list_sprints?status=open\` and pass its id in \`sprint_id\`. Cards cannot be born loose; that is a deliberate constraint to keep focus tied to the sprint goal.

## Ownership

Each card has an \`assigned_to\` field. Once set, only that actor (or a manager) can mutate the card — everyone else gets \`403 not_assigned\`. Before working on a card you do not own:

1. Call \`kanban_claim_card\` — fails with \`409 already_claimed\` if another agent got there first.
2. Do the work.
3. Call \`kanban_release_card\` when you hand off to review, or leave it claimed if you are continuing.

## Suggested first steps

1. \`kanban_list_cards\` to confirm you can read the board.
2. \`kanban_list_sprints?status=active\` to find the current sprint.
3. \`kanban_pick_next?sprint_id=...\` to find a card ready to start.
4. Claim it, move it to \`in_progress\`, do the work, log what you did, move to \`done\` — or to \`review\` if you are blocked or proposing.

## Dependencies

A card can have \`blocked_by: [card_id, ...]\`. The server refuses to advance a blocked card past \`todo\` and answers \`409 blocked { blockers }\` with the unsatisfied ids. \`kanban_pick_next\` skips blocked cards for you and reports how many candidates are still gated.

## Conflict handling

Every update takes a \`version\`. If it is stale you get \`409 conflict\` with the current card embedded in the response — merge or refetch, then retry. Never overwrite without reading first.
`
