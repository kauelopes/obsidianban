# 3. User Roles and Permissions


### 3.1  Role Matrix

Agent tokens carry an `agent_type` claim (`pm` or `dev`) that further restricts which tools are visible.

| Action | Manager | PM Agent | Dev Agent |
| --- | --- | --- | --- |
| Create card | Via plugin board (→ MCP) or directly creating .md file | Via MCP (`kanban_create_card`, `kanban_bulk_create_cards`) | **No** — dev agents never create cards |
| Read card | Direct file or plugin board | Via MCP | Via MCP |
| Log progress on card | Via plugin | Via `kanban_log_on_card` | Via `kanban_log_on_card` (primary write tool) |
| Update card fields | Obsidian editor directly or via plugin | Via `kanban_update_card` | **No** — use log + escalate instead |
| Move card (status change) | Drag in plugin board (→ MCP) or edit status field directly | Via `kanban_move_card` | Via `kanban_move_card` (also used to escalate to `review`) |
| Reorder cards | Drag in plugin board (→ MCP) | Via `kanban_reorder_card` | **No** |
| Archive / unarchive card | Yes | Via MCP | **No** |
| Manage sprints (create, start, add, close) | Yes | Via MCP | **No** |
| Hard delete card | Yes (delete file) | Via `kanban_delete_card` | **No** |
| Create / configure project | Yes (CLI + plugin) | No | No |
| Token provisioning | Yes (CLI + `kanban_create_agent_token`) | No | No |

### 3.1b  Dev Agent Communication Protocol

Dev agents cannot create cards, update card fields, or manage sprints. When a dev agent is **blocked** or needs to **propose** something (new scope, a follow-up card, an impediment), the protocol is:

1. Call `kanban_log_on_card` — document the blockage or proposal with enough detail for a PM to act without asking questions.
2. Call `kanban_move_card` to move the card to `review`.
3. Stop work on this card and call `kanban_pick_next` for the next task.

The PM agent reads cards in `review`, inspects the log, and decides:
- **Close the task** — move it to `done` or archive it.
- **Create a follow-up card** — mint a new card for the proposed work and return the original to `todo`.
- **Execute directly** — if the action is minor enough, the PM resolves the blocker and returns the card to `todo`.

### 3.2  Token Structure
There are two distinct token types, differing in scope and agent type:

| Claim | Agent Token (PM) | Agent Token (Dev) | Manager Token |
| --- | --- | --- | --- |
| `role` | `agent` | `agent` | `manager` |
| `agent_type` | `pm` | `dev` | n/a |
| `project_id` | Required — bound to exactly one project at issuance, immutable | Required — bound to exactly one project at issuance, immutable | Absent — manager token is project-unscoped (access to all projects in the vault) |

Agent tokens are issued per project and scoped to it. Manager tokens are issued once per vault and grant access to all projects. Both use the same MCP endpoints — `role` and `agent_type` are the enforcement boundaries for tool-level access control. Manager tokens are never shared with agents.

### 3.3  Agent Constraints
- Each agent token is bound to exactly one project_id at issuance. Immutable.
- project_id from token cannot be overridden by any request parameter.
- Requests with fields outside the agent-writable set are rejected with 400 and an explicit disallowed_fields list.
- Agents cannot hard-delete cards. Terminal agent-accessible state is 'archived'.
- Agents receive 404 for other projects' cards — identical to not-found.

### 3.5  Token Provisioning and Validation Flow

```mermaid
sequenceDiagram
    participant Manager
    participant CLI
    participant Meta as _meta.json
    participant MCP
    participant Agent

    Note over Manager,Meta: Provisioning (one-time, offline)
    Manager->>CLI: kanban token create --project=X --role=agent
    CLI->>Meta: append hashed token to project X's _meta.json
    CLI-->>Manager: token string (shown once — store securely)

    Manager->>CLI: kanban token create --role=manager
    CLI->>Meta: store hashed manager token in vault config (no project_id)
    CLI-->>Manager: manager token string

    Note over Agent,MCP: Runtime — agent makes MCP call
    Agent->>MCP: tool call + Bearer <agent-token>
    MCP->>Meta: load _meta.json for all projects
    MCP->>MCP: hash(token) → match against stored hashes
    alt no match
        MCP-->>Agent: 401 Unauthorized
    else match found
        MCP->>MCP: extract role + project_id from token record
        MCP->>MCP: enforce project scope — BR-02
        MCP->>MCP: enforce role field access — §3.2
        MCP-->>Agent: proceed with request
    end
```

### 3.4  Human Edit Expectations
- Humans can freely edit the body (Markdown below the frontmatter separator) with no restrictions.
- Humans can edit mutable frontmatter fields (title, status, priority, tags, due_date, assigned_to, owner, agent_notes) directly.
- Changes to immutable fields (id, project, version, created_at, created_by) are silently reverted. A FIELD_REVERTED entry is written to the audit log.
- The plugin collapses the frontmatter block by default and shows an advisory banner to reduce accidental edits.

