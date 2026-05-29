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

Both transports expose the **same seventeen tools** (`kanban_list_cards`,
`kanban_get_card`, `kanban_create_card`, `kanban_bulk_create_cards`,
`kanban_update_card`,
`kanban_move_card`, `kanban_reorder_card`, `kanban_delete_card`,
`kanban_archive_card`, `kanban_unarchive_card`, `kanban_claim_card`,
`kanban_release_card`, `kanban_create_project`, `kanban_list_projects`,
`kanban_archive_project`, `kanban_unarchive_project`,
`kanban_delete_project`). All `*_project` tools except `list_projects`
are manager-only; `list_projects` is scoped to the caller's project for
agents and unscoped for managers. `delete_project` requires `confirm`
to equal the project name. Cards are gated by `assigned_to`: mutating a
card owned by another actor returns 403 — use `kanban_claim_card` to
take ownership of an unassigned card, then `kanban_release_card` when
you're done. Pick
based on where the agent runs.

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
const res = await fetch('http://127.0.0.1:3000/mcp/tool/kanban_create_card', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.KANBAN_MCP_TOKEN}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    title: 'task from agent',
    type: 'task',
    input_tokens: 120, output_tokens: 8,
    model: 'claude-opus-4-7',
    request_id: crypto.randomUUID(),
  }),
})
```

The full integration pattern (idempotency, 409 handling, SSE) is in
`integration-guide.md` with a runnable example.

---

## 5. Operating the server

### Start (HTTP mode, for remote / multiple agents)

```bash
VAULT_PATH=/path/to/vault node_modules/.bin/tsx src/index.ts
```

Default port `3000`, override with `MCP_HTTP_PORT`. The process logs
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
curl http://127.0.0.1:3000/metrics | jq .summary
curl 'http://127.0.0.1:3000/metrics?from_date=2026-05-01&to_date=2026-05-31' | jq .by_agent
```

`/metrics` is loopback-only and needs no auth.

---

## 6. Common failure modes

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

## 7. Security checklist before granting access

- [ ] Token role matches the agent's blast radius (`agent` unless you need vault-wide)
- [ ] `--actor` string identifies the agent clearly enough that you can revoke the right one in 6 months
- [ ] The token is **not** committed to a repo (use `.env` + gitignore or your secret manager)
- [ ] If you exposed the HTTP server beyond loopback: TLS in front of it, firewall scoped to known IPs, and you understand that bearer tokens over plain HTTP are sniffable on any shared network
- [ ] Audit log rotation is set up if the agent is high-volume (audit.ndjson grows monotonically — known follow-up for V1.1)

---

## 8. Quick reference

```
# Mint
VAULT_PATH=$V tsx src/auth/cli.ts create --project P --role agent --actor agent:NAME
VAULT_PATH=$V tsx src/auth/cli.ts create --role manager --actor human:NAME

# Revoke
VAULT_PATH=$V tsx src/auth/cli.ts revoke --token-id tk_XXXXXXXX

# Start (HTTP)
VAULT_PATH=$V tsx src/index.ts                         # port 3000
VAULT_PATH=$V MCP_HTTP_PORT=4000 tsx src/index.ts      # custom port

# Start (stdio — usually launched by the agent client)
VAULT_PATH=$V KANBAN_MCP_TOKEN=kbn_... tsx src/index.ts --stdio

# Observe
tail -f $V/.kanban/audit.ndjson
curl http://127.0.0.1:3000/metrics | jq
curl http://127.0.0.1:3000/health
```
