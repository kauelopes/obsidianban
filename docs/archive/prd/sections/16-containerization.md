# 16. Containerization

The MCP Server is the only containerized component. The Obsidian plugin runs inside Obsidian Desktop on the host. The vault filesystem is mounted as a volume — all persistent state (`.md` files, SQLite, audit log) lives on the host, never inside the container.

### 16.1  Base Image

`node:22-slim` (Debian 12 slim, glibc).

`better-sqlite3` ships pre-compiled glibc binaries for linux-x64 — no native compilation step, no build tools (`python3`, `make`, `g++`), no multi-stage build. Single-stage Dockerfile, image size ~110 MB.

### 16.2  Container Responsibilities

| Inside container | Outside container (host) |
| --- | --- |
| MCP Server process (HTTP+SSE on port 9375) | Obsidian Desktop + Plugin |
| File Watcher (chokidar, watching `/vault`) | Vault filesystem (mounted in) |
| SQLite index (at `/vault/.kanban/db.sqlite`) | Agent processes (connect via HTTP or `podman exec`) |
| Audit log (at `/vault/.kanban/audit.ndjson`) | |

### 16.3  Volume Mount

| Host path | Container path | Access | Notes |
| --- | --- | --- | --- |
| `$VAULT_PATH` | `/vault` | read-write | Required. All card `.md` files, SQLite index, audit log and token files live here. |

### 16.4  Port Exposure

| Port | Protocol | Bound to | Purpose |
| --- | --- | --- | --- |
| 9375 | HTTP | `127.0.0.1` | Plugin board actions, remote agents, SSE event stream (`GET /events`), health check (`GET /health`), metrics (`GET /metrics`) |

Bound to loopback only — not externally reachable. Configurable via `MCP_HTTP_PORT`.

### 16.5  Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `VAULT_PATH` | Yes | — | Absolute path to the Obsidian vault on the host |
| `MCP_HTTP_PORT` | No | `9375` | HTTP port inside the container (always mapped to same port on host) |
| `LOG_LEVEL` | No | `info` | `debug \| info \| warn \| error` |
| `NODE_ENV` | No | `production` | Node.js environment |

### 16.6  Podman Rootless Considerations

Tested on Podman 3.4.4+. `podman compose` is not used — `podman run` via `container.sh` is the operational interface (see §16.8).

| Concern | Solution |
| --- | --- |
| File ownership on vault mount | `--userns=keep-id` in `podman run` — maps the running host UID to the same UID inside the container (uid 1000 = `node` user). The container process reads and writes vault files as the host user. |
| SELinux (Fedora, RHEL) | `:z` suffix on the vault volume mount relabels the directory so the container can access it. Use `:Z` if the vault should not be shared between containers. |
| inotify watch limits | On large vaults chokidar may fail silently if the host limit is too low. Fix: `echo fs.inotify.max_user_watches=524288 \| sudo tee /etc/sysctl.d/40-inotify.conf && sudo sysctl -p` |
| stdio transport in container | Use `./container.sh exec node src/index.js --stdio` or `podman exec -i obsidiankan-mcp node src/index.js --stdio`. Remote agents use HTTP+SSE. |

### 16.7  Health Check Endpoint

`GET /health` — no authentication. Localhost-only. See §6.11.

The container HEALTHCHECK polls this endpoint every 10 seconds. The Obsidian plugin also uses it for its 5-second MCP-offline detection (§11.4).

### 16.8  Running with Podman

All operations are handled by `container.sh`, which wraps `podman run` and sources `.env` automatically.

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env: set VAULT_PATH to your Obsidian vault path

# 2. Build the image
./container.sh build

# 3. Start the MCP server (detached)
./container.sh start

# 4. Check status and follow logs
./container.sh status
./container.sh logs

# 5. Rebuild and restart after code changes
./container.sh stop
./container.sh build
./container.sh start

# 6. Stop and remove container (vault data preserved on host)
./container.sh stop
```

### 16.9  stdio Transport via container exec

For local agents that require stdio (MCP stdio transport):

```bash
./container.sh exec node src/index.js --stdio
```
