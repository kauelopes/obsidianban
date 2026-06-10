# ObsidianKan — Overview

ObsidianKan is an MCP (Model Context Protocol) server that turns an Obsidian vault into a collaborative Kanban board, accessible by both humans and AI agents.

---

## What it does

The server exposes a set of MCP tools for creating, moving, and tracking work cards — stored as `.md` files inside the vault. Everything an agent writes appears immediately in Obsidian; everything a human edits in Obsidian is automatically reconciled by the server.

```
AI Agents ──► MCP Server ──► .md files in the Obsidian vault
                  │
              SQLite index (cache)
                  │
              Obsidian Plugin (visual board + SSE)
```

---

## Core components

### MCP Server
A Node.js process that exposes 27 tools over two transports:

- **stdio** — for local agents (Claude Desktop, Claude Code). The client spawns the MCP process as a child.
- **HTTP + SSE** — for remote agents or polyglot stacks. Binds to `127.0.0.1:9375` by default.

### Vault
The Obsidian directory where data lives:

```
vault/
  kanban-data/
    <project>/
      <card-slug>.md      # one file per card
      _meta.json          # columns, sprints, and project token hashes
  .kanban/
    db.sqlite             # derived index (rebuildable)
    audit.ndjson          # immutable log of all mutations
    manager-tokens.json   # manager tokens (SHA-256 hashes)
  _kanban-secrets/
    <project>.md          # raw token shown exactly once at project creation
```

### Obsidian Plugin
The visual board interface. Consumes tools via HTTP and receives real-time events via SSE (`/events`). Does not write files directly — all mutations go through the MCP server.

---

## Cards

Each card is a Markdown file with YAML frontmatter managed by the server:

```markdown
---
id: card-a1b2c3d4
project: marketing
type: feature
status: in_progress
priority: high
assigned_to: agent:claude-dev
sprint_id: sprint-x9y8z7w6
version: 5
created_at: 2026-05-10T14:00:00Z
---

Card body — freely editable by humans or agents.

# Agent Log
- **2026-05-12T09:00:00Z** — started work on the login screen.
- **2026-05-12T11:30:00Z** — blocked: missing auth endpoint. Moving to review.
```

Immutable fields (`id`, `project`, `type`, `version`, `created_at`) are automatically reverted if a human edits them in Obsidian.

---

## Sprints

Every card belongs to a sprint. The lifecycle is one-directional:

```
planning → active → closed
```

Only one `active` sprint can exist per project at a time. Cards in `done` are automatically archived when the sprint is closed. Unfinished cards can be moved to a planning sprint via `rollover_to`.

---

## Roles and permissions

Three access levels exist, controlled by token type:

| | Dev Agent | PM Agent | Manager |
|---|---|---|---|
| Read and query cards | ✅ | ✅ | ✅ |
| Log progress on a card | ✅ | ✅ | ✅ |
| Move cards between columns | ✅ | ✅ | ✅ |
| Claim / release cards | ✅ | ✅ | ✅ |
| Create cards | ❌ | ✅ | ✅ |
| Update card fields | ❌ | ✅ | ✅ |
| Manage sprints | ❌ | ✅ | ✅ |
| Archive / delete cards | ❌ | ✅ | ✅ |
| Create projects and tokens | ❌ | ❌ | ✅ |

### Dev Agent escalation protocol

Dev agents cannot create cards. When blocked or wanting to propose something:

1. **`kanban_log_on_card`** — documents the problem or proposal on the card.
2. **`kanban_move_card { to_status: "review" }`** — hands the card off to the PM.
3. **`kanban_pick_next`** — moves on to the next available work.

The PM agent reads cards in `review` and decides: close it, create a new card, or resolve the blocker and return it to `todo`.

---

## Typical workflow

```
Manager
  └─► creates project (kanban_create_project)
  └─► mints PM and Dev tokens (kanban_create_agent_token)

PM Agent
  └─► creates sprint (kanban_create_sprint)
  └─► creates cards in the backlog (kanban_create_card / kanban_bulk_create_cards)
  └─► starts sprint (kanban_start_sprint → cards move to todo)

Dev Agent
  └─► picks next card (kanban_pick_next)
  └─► claims the card (kanban_claim_card)
  └─► works → logs progress (kanban_log_on_card)
  └─► moves to done (kanban_move_card)
       OR
  └─► blocked → logs + moves to review (kanban_log_on_card + kanban_move_card)

PM Agent
  └─► reads review cards, decides and acts
  └─► closes sprint (kanban_close_sprint)
```

---

## Consistency guarantees

- **Atomic writes** — every mutation uses `.tmp → rename`. No partially written files.
- **Optimistic versioning** — every mutating call requires the current `version`. Conflict returns 409 with the current card state.
- **Idempotency** — every call accepts a `request_id` (UUID v4). Retrying with the same id returns the cached response without re-executing.
- **SQLite as cache** — the index is always rebuildable from the `.md` files. On startup, the server reconciles divergences by SHA-256.
- **Audit log** — every mutation (MCP or human edit) is recorded in `audit.ndjson` with operation, actor, version, and tokens consumed.

---

## Reference docs

| Document | Contents |
| --- | --- |
| `docs/agent-runbook.md` | How to mint tokens, configure clients, operate the server |
| `docs/integration-guide.md` | Full wire protocol: auth, idempotency, conflicts, SSE |
| `docs/design/mcp-server.md` | Class diagrams and design invariants |
| `docs/prd/sections/` | Full PRD: data model, business rules, workflows |
| `docs/architecture/` | Sprint reports with architecture decisions |
