# Agent Runbook

How to give an AI agent access to your ObsidianKan MCP server: token,
transport, client config, and the day-to-day operations (rotate, revoke,
audit).

This is the **operator's** view. For the wire protocol (request/response
shapes, idempotency, conflict handling) see `integration-guide.md`.

---

## 1. Decide what the agent can see

Two scopes exist. Pick before issuing the token — they cannot be changed
after.

| Token role | Sees                                          | Use when                                                                                                 |
| ---------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `agent`    | One project (the one named at token creation) | The agent is doing work on a specific project — its writes auto-scope, no cross-project leakage possible |
| `manager`  | The whole vault (every project)               | The agent orchestrates across projects, or you want a single token for personal CLI tooling              |

**Default to `agent`.** A scoped token contains a bad/confused agent
to one project; recovering from a manager-token mistake means restoring
the whole vault from backup.

---

## 2. Mint the token

The CLI runs against your live vault and writes the SHA-256 hash to
`<vault>/.kanban/manager-tokens.json` (for manager) or to the project's
`_meta.json` (for agent). The raw token is printed **once** — store it
immediately.

```bash
# Agent token for project "marketing"
VAULT_PATH=/path/to/vault \
  node_modules/.bin/tsx src/auth/cli.ts create \
    --project marketing \
    --role agent \
    --actor agent:claude-marketing

# Manager token
VAULT_PATH=/path/to/vault \
  node_modules/.bin/tsx src/auth/cli.ts create \
    --role manager \
    --actor human:kaue
```

Output:

```
created token tk_a1b2c3d4 for agent:claude-marketing on project marketing
token:  kbn_t_<raw token — copy now>
```

The `--actor` string ends up in every audit row and SSE event the agent
generates. Make it specific (`agent:claude-marketing`, not `agent:1`) so
the audit log is meaningful months later.

### Mint from inside Obsidian

If the plugin is configured with a **manager** token, the command palette
exposes **"Create kanban project"**. It prompts for a project name + actor,
calls `kanban_create_project`, writes a copy of the token to
`_kanban-secrets/<project>.md` inside the vault, and surfaces the raw token
in a one-shot modal with a Copy button. Use this when you don't want to
shell into the server to issue tokens. Agent tokens calling the same tool
get `403 forbidden { reason: "manager_required" }`.

### List / revoke later

```bash
# Audit who has access
node_modules/.bin/tsx src/auth/cli.ts list

# Revoke a leaked or retired token
node_modules/.bin/tsx src/auth/cli.ts revoke --token-id tk_a1b2c3d4
```

Revocation is immediate: the SHA-256 entry is marked `revoked_at` and
the next request with that token returns `401 token_revoked`.

---

## 3. Pick the transport

Both transports expose the **same twenty-seven tools**, but which ones are
**visible** depends on the token's `agent_type`:

| Tool | Dev agent | PM agent | Manager |
|------|-----------|----------|---------|
| `kanban_list_cards` | ✅ | ✅ | ✅ |
| `kanban_get_card` | ✅ | ✅ | ✅ |
| `kanban_log_on_card` | ✅ | ✅ | ✅ |
| `kanban_move_card` | ✅ | ✅ | ✅ |
| `kanban_claim_card` | ✅ | ✅ | ✅ |
| `kanban_release_card` | ✅ | ✅ | ✅ |
| `kanban_pick_next` | ✅ | ✅ | ✅ |
| `kanban_list_sprints` | ❌ | ✅ | ✅ |
| `kanban_get_sprint` | ❌ | ✅ | ✅ |
| `kanban_create_card` | ❌ | ✅ | ✅ |
| `kanban_bulk_create_cards` | ❌ | ✅ | ✅ |
| `kanban_update_card` | ❌ | ✅ | ✅ |
| `kanban_reorder_card` | ❌ | ✅ | ✅ |
| `kanban_delete_card` | ❌ | ✅ | ✅ |
| `kanban_archive_card` | ❌ | ✅ | ✅ |
| `kanban_unarchive_card` | ❌ | ✅ | ✅ |
| `kanban_create_sprint` | ❌ | ✅ | ✅ |
| `kanban_start_sprint` | ❌ | ✅ | ✅ |
| `kanban_add_to_sprint` | ❌ | ✅ | ✅ |
| `kanban_move_between_sprints` | ❌ | ✅ | ✅ |
| `kanban_close_sprint` | ❌ | ✅ | ✅ |
| `kanban_create_project` | ❌ | ❌ | ✅ |
| `kanban_create_agent_token` | ❌ | ❌ | ✅ |
| `kanban_list_projects` | ❌ | ❌ | ✅ |
| `kanban_archive_project` | ❌ | ❌ | ✅ |
| `kanban_unarchive_project` | ❌ | ❌ | ✅ |
| `kanban_delete_project` | ❌ | ❌ | ✅ |

`ListTools` only returns the tools the caller can actually invoke — an agent
never sees tools it can't use. `delete_project` requires `confirm` to equal
the project name. Cards are gated by `assigned_to`: mutating a card owned
by another actor returns 403 — use `kanban_claim_card` to take
ownership of an unassigned card, then `kanban_release_card` when you're
done. **Every new card requires a `sprint_id`** in a planning or active
sprint; PM agents can call `kanban_list_sprints?status=open` first to find a
valid target.

**Dev agents and the active sprint.** All tools available to a dev agent
require an active sprint in the project. If no sprint is active, every call
returns `409 no_active_sprint`. Additionally, `kanban_list_cards` and
`kanban_pick_next` automatically scope their results to the active sprint —
passing a different `sprint_id` is not allowed and will be overridden.

### Dev agent escalation protocol

Dev agents cannot create cards. When a dev agent is **blocked** or wants to
**propose** new work, it must communicate through the card in `review`:

1. `kanban_log_on_card` — write a clear explanation of the blockage or
   proposal (what you tried, what failed, what you recommend).
2. `kanban_move_card { to_status: "review" }` — hand the card to the PM.
3. `kanban_pick_next` — continue with the next available task.

The PM reads cards in `review` and decides whether to close the task, create
a follow-up card, or resolve the blocker and return the card to `todo`.

Pick based on where the agent runs.

| Transport | Best for                                                                                                          | Notes                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **stdio** | Agents that run on the same machine and can spawn subprocesses (Claude Desktop, Claude Code, MCP-aware IDEs)      | One MCP process per agent. Token via env var, not a header.                            |
| **HTTP**  | Remote agents, polyglot stacks, agents that already have a long-lived process and would rather connect than spawn | Loopback-only by default; bind elsewhere only if you understand the security trade-off |

---

## 4. Wire it up — by client

### 4a. Claude Desktop (Anthropic)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

```json
{
  "mcpServers": {
    "obsidiankan": {
      "command": "node",
      "args": [
        "/absolute/path/to/obsidianban/node_modules/.bin/tsx",
        "/absolute/path/to/obsidianban/src/index.ts",
        "--stdio"
      ],
      "env": {
        "VAULT_PATH": "/absolute/path/to/your/vault",
        "KANBAN_MCP_TOKEN": "kbn_t_<your raw token>"
      }
    }
  }
}
```

Restart Claude Desktop. The seven tools appear in the tool drawer.

### 4b. Claude Code (CLI)

```bash
claude mcp add obsidiankan \
  --command node \
  --args "/absolute/path/to/obsidianban/node_modules/.bin/tsx,/absolute/path/to/obsidianban/src/index.ts,--stdio" \
  --env "VAULT_PATH=/absolute/path/to/your/vault" \
  --env "KANBAN_MCP_TOKEN=kbn_t_<your raw token>"
```

Or edit `.mcp.json` in your project root directly.

### 4c. Cursor / Windsurf / other MCP-aware IDEs

Open the IDE's MCP settings. Same shape as Claude Desktop — one server
entry with `command`, `args`, and `env`.

### 4d. Custom agent via HTTP

For agents you build yourself (or any service speaking HTTP), don't use
stdio — connect to the running HTTP server instead:

```ts
const res = await fetch('http://127.0.0.1:9375/mcp/tool/kanban_create_card', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.KANBAN_MCP_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    title: 'task from agent',
    type: 'task',
    sprint_id: 'sprint-abc12345', // required — get one from kanban_list_sprints?status=open
    input_tokens: 120, output_tokens: 8,
    model: 'claude-opus-4-7',
    request_id: crypto.randomUUID(),
  }),
})
```

The full integration pattern (idempotency, 409 handling, SSE) is in
`integration-guide.md` with a runnable example.

---

## 5. Orchestrating a PM → dev agent (headless)

The common topology: **one PM agent that plans and supervises, and at least one
dev agent that executes the board.** The PM dispatches the dev, the dev works,
the PM reads back the result and decides what's next.

### Why a separate process, not a subagent

The token **is** the identity. `kanban_claim_card` infers `assigned_to` from the
token (not a parameter), cost attribution follows the token, and the dev-vs-pm
tool scope is enforced server-side from the token's `agent_type`. A Claude Code
**subagent** (`.claude/agents/*.md`) gets a separate *context window* but
**shares the parent session's MCP connection — and therefore the parent's
token.** A subagent dev would act on the board as the PM: wrong `assigned_to`,
wrong cost attribution, and the server-side dev restriction never applies.

So the dev runs as its **own headless process** with its **own dev token**. The
token boundary is the process boundary — exactly the "one MCP process per agent,
token via env var" rule from §3.

### The three files — bundled in the PM skill

These live **inside the `kanban-pm-agent` skill** (not at the repo root) so the
whole capability travels with a copy/paste of the skill folder into any project.
Paths resolve relative to the script, never to the host repo.

| File (in `.claude/skills/kanban-pm-agent/`) | Purpose |
|------|---------|
| `dev.mcp.json` | MCP config exposing **only** the kanban server over **HTTP** (`url: http://127.0.0.1:9375/mcp`), with `Authorization: Bearer ${KANBAN_DEV_TOKEN}`. No path to the MCP build — the server is a shared service, external to the project. |
| `dev-settings.json` | `permissions.deny` for `Skill(kanban-pm-agent)` and `Skill(kanban-manager-agent)` — stops the dev from loading PM/manager guidance it can't act on |
| `spawn-dev.sh` | Wrapper the PM calls via Bash: checks prerequisites, pings the server, launches the dev, parses the JSON result |

The launch isolates the dev on three independent planes:

- `--strict-mcp-config --mcp-config <skill>/dev.mcp.json` — the dev sees **only**
  the kanban server, ignoring the project `.mcp.json` and any other MCP config.
- `--settings <skill>/dev-settings.json` — denies the PM/manager skills (client
  plane, anti-confusion).
- the **dev token** in the `Bearer` header — restricts the tool surface
  server-side (authoritative plane).

Because the connection is HTTP to a shared server, the only per-project input is
the **dev token** (an env var) — nothing in the bundle is repo-specific, which
is what makes the skill portable across every new project.

### Dispatch and read the result

The PM (running with its own PM token) calls, from the project root:

```bash
KANBAN_DEV_TOKEN=kbn_t_<dev raw token> \
  .claude/skills/kanban-pm-agent/spawn-dev.sh "Implement the auth cards in the active sprint"
```

(The dev process inherits the project cwd, so it auto-discovers that project's
`kanban-dev-agent` skill. The shared HTTP server must be running — `spawn-dev.sh`
pings `KANBAN_URL/health` first and aborts with a clear message if it isn't.)

`spawn-dev.sh` runs `claude -p ... --output-format json`, which prints a single
result object on stdout when the dev finishes:

```json
{
  "is_error": false,
  "result": "Finished 3 auth cards. Moved AUTH-204 to review: needs a client secret — escalated.",
  "session_id": "9f2c…-uuid",
  "num_turns": 14,
  "total_cost_usd": 0.4127,
  "usage": { "input_tokens": 38211, "output_tokens": 5904 },
  "duration_ms": 92344
}
```

The wrapper reads it with `jq`: `is_error` (→ exit 1 on failure), `result` (the
dev's prose summary), `session_id` (for resume), and the cost/usage fields —
attributed correctly because the dev ran as its own process and token.

### The handoff goes through the board, not the prompt

The PM does **not** pass tasks to the dev as arguments. The contract is the
board itself:

1. PM creates cards + `kanban_start_sprint` (promotes `backlog → todo`).
2. PM dispatches the dev with a generic instruction ("work the active sprint").
3. Dev loops `pick_next → claim → in_progress → log → done`, and on a blocker
   follows the escalation protocol (§3): log + move to `review`.
4. Dev exits; PM reads the result JSON to know it finished and what it cost.
5. PM — with its **own** token — calls `kanban_get_sprint` / lists `review` to
   see the *authoritative* state, and decides: close, follow-up, or unblock.

`result` is just a summary; the source of truth is the board, which the dev
already updated via `kanban_move_card` / `kanban_log_on_card`.

### Resume — continue the same dev

The wrapper echoes the `session_id`. To continue the **same** dev (preserving
its context) instead of starting fresh, set `RESUME_SESSION_ID`:

```bash
RESUME_SESSION_ID=9f2c…-uuid \
KANBAN_DEV_TOKEN=kbn_t_<dev raw token> \
  .claude/skills/kanban-pm-agent/spawn-dev.sh "AUTH-204 is unblocked: the client secret is on the card. Continue."
```

When set, the wrapper adds `--resume <id>` so the dev picks up with full memory
of the previous round.

| Situation | PM action |
|-----------|-----------|
| Continuation of the same work (unblocked a card, asked for a tweak) | **resume** — reuses context, cheaper and coherent |
| New independent batch (other feature, board changed a lot) | **fresh** — clean context, no irrelevant history dragged along |
| Previous dev failed (`is_error`) | **fresh** |

Rule of thumb: **resume preserves reasoning, fresh preserves focus.** Because
the authoritative work state lives on the board (not in the dev's context), a
fresh spawn never *loses* work — the dev just re-reads the board via
`pick_next`. When in doubt, fresh is safe; resume is an optimization for genuine
continuity.

### Scaling to N devs

Because the dev connects over HTTP to one shared server, parallelism is free:
dispatch `spawn-dev.sh` several times (each with its own dev token) and every
dev process connects to the same URL. No extra server processes, no port
juggling — the server already handles concurrent agents and the board's
`assigned_to` / version checks keep them from colliding.

---

## 6. Operating the server

### Start (HTTP mode, for remote / multiple agents)

```bash
VAULT_PATH=/path/to/vault node_modules/.bin/tsx src/index.ts
```

Default port `9375`, override with `MCP_HTTP_PORT`. The process logs
`[startup] vault=... ready` when the file watcher is armed.

For stdio agents, **do not start a separate HTTP server** — each MCP
client spawns its own MCP process. Running an HTTP MCP at the same time
is fine (separate process, different transport) but consumes a port.

### Stop

`Ctrl+C` or `SIGTERM`. Both shut down cleanly: watcher detaches, SQLite
WAL flushes, atomic writer drains.

### Inspect what the agent did

```bash
tail -f /path/to/vault/.kanban/audit.ndjson
```

Each mutating call appends one NDJSON row with `op`, `actor`, `card_id`,
`version`, and the token-tracking fields. Filter with `jq`:

```bash
jq 'select(.actor=="agent:claude-marketing" and .op=="CREATE")' \
  /path/to/vault/.kanban/audit.ndjson
```

For token consumption summaries, hit the metrics endpoint:

```bash
curl http://127.0.0.1:9375/metrics | jq .summary
curl 'http://127.0.0.1:9375/metrics?from_date=2026-05-01&to_date=2026-05-31' | jq .by_agent
```

`/metrics` is loopback-only and needs no auth.

---

## 7. Common failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `401 missing_token` | Bearer header missing or env var typo | Verify `KANBAN_MCP_TOKEN` in the client env block |
| `401 token_revoked` | Token revoked or `_meta.json` modified | Mint a new token, update the client env |
| `403 forbidden / localhost_only` | Hitting `/metrics` from a non-loopback IP | By design — metrics never leave the host |
| `400 invalid_request_id` | `request_id` is not a UUID v4 | Use `crypto.randomUUID()` |
| `400 invalid_fields` with `disallowed_fields: ["project"]` | Agent token sent `project` in update/move/etc. | Strip it — agents derive project from the token |
| `404` on a card you know exists | Cross-project access with an agent token | Either use a manager token or scope the agent to that project |
| `409 conflict` repeatedly | Stale version in the agent's working state | Re-fetch the card before retry; see integration-guide.md §5 |
| Plugin shows "offline" but agent works | SSE connection died, HTTP still works | Plugin auto-reconnects (5s backoff cap); if persistent, restart the plugin |

---

## 8. Security checklist before granting access

- [ ] Token role matches the agent's blast radius (`agent` unless you need vault-wide)
- [ ] `--actor` string identifies the agent clearly enough that you can revoke the right one in 6 months
- [ ] The token is **not** committed to a repo (use `.env` + gitignore or your secret manager)
- [ ] If you exposed the HTTP server beyond loopback: TLS in front of it, firewall scoped to known IPs, and you understand that bearer tokens over plain HTTP are sniffable on any shared network
- [ ] Audit log rotation is set up if the agent is high-volume (audit.ndjson grows monotonically — known follow-up for V1.1)

---

## 9. Quick reference

```
# Mint
VAULT_PATH=$V tsx src/auth/cli.ts create --project P --role agent --actor agent:NAME
VAULT_PATH=$V tsx src/auth/cli.ts create --role manager --actor human:NAME

# Revoke
VAULT_PATH=$V tsx src/auth/cli.ts revoke --token-id tk_XXXXXXXX

# Start (HTTP)
VAULT_PATH=$V tsx src/index.ts                         # port 9375
VAULT_PATH=$V MCP_HTTP_PORT=4000 tsx src/index.ts      # custom port

# Start (stdio — usually launched by the agent client)
VAULT_PATH=$V KANBAN_MCP_TOKEN=kbn_... tsx src/index.ts --stdio

# Dispatch a dev agent (headless) — PM calls this, reads the JSON result
#   (needs the shared HTTP server running + a dev token; script lives in the PM skill)
KANBAN_DEV_TOKEN=kbn_... .claude/skills/kanban-pm-agent/spawn-dev.sh "work the active sprint"
# Resume the same dev session
RESUME_SESSION_ID=<id> KANBAN_DEV_TOKEN=kbn_... .claude/skills/kanban-pm-agent/spawn-dev.sh "continue"

# Observe
tail -f $V/.kanban/audit.ndjson
curl http://127.0.0.1:9375/metrics | jq
curl http://127.0.0.1:9375/health
```
