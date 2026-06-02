# ObsidianKanban MCP

**Give your AI agents a shared project board — with the reliability of a database and the simplicity of Markdown files.**

ObsidianKanban MCP turns an Obsidian vault into a fully operational Kanban system that AI agents and humans can use simultaneously, without stepping on each other.

---

## The problem

AI agents are increasingly capable of managing long-running tasks — but they have no reliable place to track work shared with humans.

Most setups force a choice:

- **Use a task manager** — agents can't write to it natively, integrations are brittle, and humans lose their familiar workspace
- **Use plain files** — no structure, no concurrency control, no way to enforce consistency when multiple agents or tools write at the same time

The result: agents hallucinate task state, duplicate work, or silently overwrite each other's changes.

---

## The solution

ObsidianKanban MCP is a Kanban server built on top of an Obsidian vault. Cards are `.md` files — readable and editable by anyone. A lightweight MCP server sits in front and gives agents a structured, safe, auditable interface to read and write those cards.

Humans keep using Obsidian as they always have. Agents call MCP tools. Both write paths are fully supported and reconciled automatically.

```
AI Agents                       Humans
    │                               │
    │  MCP (stdio / HTTP)           ├─ Kanban board (plugin)
    ▼                               └─ Native Obsidian editor
 MCP Server ────────────────────────────────────────────────►
    │  atomic writes, versioning, audit log                  │
    ▼                                                        │
 .md files  ◄──── file watcher reconciles all edits ────────┘
    │
    ▼
 SQLite index  (fast queries, always rebuilable from .md files)
```

---

## Why it works

**Cards are just Markdown files.**
No proprietary formats. No lock-in. Humans can read, edit, and annotate any card directly in Obsidian. The system embraces this instead of fighting it.

**Agents write through a disciplined interface.**
The MCP server validates every agent write: field types, column existence, version conflicts. Agents get clear error responses — not silent failures.

**Conflicts are explicit and recoverable.**
Every card has an integer version. If two agents attempt to update the same card, one gets a `409 Conflict` response with the current card state and a list of conflicting fields — enough to retry intelligently.

**Retries are safe by design.**
Every mutating operation accepts a `request_id`. If an agent retries after a timeout, the server returns the original response without creating a duplicate. The idempotency store survives server restarts.

**Human edits are reconciled, not blocked.**
When a human edits a card directly in Obsidian, the file watcher detects the change within milliseconds, validates it, reverts any system-managed fields, and updates the SQLite index — all automatically. Humans never need to think about it.

**Nothing is ever lost.**
SQLite is a derived index. If it's deleted, the server rebuilds it from the `.md` files on the next startup. The `.md` files are always the source of truth.

**Everything is audited.**
Every mutation — agent writes, human edits, field reversions, external sync events — produces an entry in an append-only audit log. Full traceability with zero configuration.

---

## MCP Tools

| Tool | What it does |
|---|---|
| `kanban_list_cards` | List cards with filters by status, tags, or assignee — served directly from SQLite |
| `kanban_get_card` | Get a single card including its full Markdown body |
| `kanban_create_card` | Create a card with title, status, priority, tags, due date, body, and more |
| `kanban_update_card` | Update card fields — rejects unauthorized fields with a clear error |
| `kanban_move_card` | Move a card to another column, appended to the end |
| `kanban_reorder_card` | Reorder a card within its column — positions normalized automatically |

---

## Designed for multi-agent workflows

- **Token-scoped authorization** — each agent token is bound to a single project; cross-project access returns 404, not 403
- **Concurrent agents** — version-based optimistic locking ensures no silent overwrites
- **Parallel safe retries** — `request_id` deduplication works even with multiple agents retrying simultaneously
- **Human + agent coexistence** — both write paths are first-class; neither blocks the other

---

## Tech stack

- **MCP Server:** Node.js / TypeScript
- **Transports:** stdio (local agents) + Streamable HTTP at `/mcp` (remote agents); plugin uses HTTP + a `/events` stream for live board updates
- **Storage:** `.md` files as source of truth + SQLite index (`better-sqlite3`)
- **File watching:** chokidar with 500ms debounce per file
- **Plugin:** Obsidian Desktop (TypeScript)

---

## Status

Under active development. Full PRD and implementation plan available in [`docs/prd/`](docs/prd/).
