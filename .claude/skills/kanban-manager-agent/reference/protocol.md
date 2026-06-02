# Manager Agent — Wire Protocol Reference

Runtime detail for vault-wide provisioning and token issuance. Load this for
exact params on the admin tools or unfamiliar errors.

## Error envelope

Every failure returns `{ error, reason?, hint?, ... }`. **Always read `hint`**.
`400` bad input, `403` forbidden, `404` not found, `409` conflict / state.

## Scope

A manager token is **vault-wide**: it reads and mutates every project, and the
`project` field becomes required on tools that agents infer from their token
(e.g. `create_card`, `list_sprints`, `create_sprint` need an explicit
`project`). This breadth is also the blast radius — prefer minting scoped agent
tokens for actual work.

## Admin tools

| Tool | Required | Optional | Notes |
|------|----------|----------|-------|
| `create_project` | `name`, `actor` | — | creates the project folder and returns an **initial pm token** in the response — shown once, capture it |
| `create_agent_token` | `project`, `actor` | `agent_type` (default `pm`) | mints a token; see token semantics below |
| `list_projects` | — | archive filters | |
| `archive_project` | (project ref) | — | hide from default listings (reversible) |
| `unarchive_project` | (project ref) | — | restore |
| `delete_project` | project + `confirm` | — | permanent; `confirm` must equal the project name exactly |

## Token semantics (what you grant)

| `agent_type` | Can | Cannot |
|--------------|-----|--------|
| `pm` | plan + execute: create/update cards, manage sprints, view sprint info | create projects, mint tokens |
| `dev` | execute only: pick, claim, log, move, escalate to `review` | create cards, touch sprints; all calls require an active sprint and auto-scope to it |

Make `actor` specific (`agent:claude-marketing`, not `agent:1`) — it lands in
every audit row and is how you revoke the right token later.

## Provisioning sequence

1. `create_project { name, actor }` → capture the returned pm token.
2. Hand the pm token to a planning agent (runs `kanban-pm-agent`): it creates a
   sprint, breaks the goal into cards, starts the sprint.
3. `create_agent_token { project, actor, agent_type: "dev" }` for each
   execution agent (runs `kanban-dev-agent`).
4. Step in only for cross-project moves or new provisioning — leave card/sprint
   work to the pm and dev agents.

## Errors

| Error | Cause | Recovery |
|-------|-------|----------|
| `403 forbidden` `manager_required` | non-manager called an admin tool | use a manager token |
| `400` on `delete_project` | `confirm` ≠ project name | pass the exact project name |
| `404` | wrong `project` on a vault-wide call | check `list_projects` for the exact id |

The pm/dev card and sprint protocol (which a manager token can also use) is
documented in the `kanban-pm-agent` and `kanban-dev-agent` skills.
