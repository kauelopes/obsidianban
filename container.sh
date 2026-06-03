#!/usr/bin/env sh
# container.sh — build and run the ObsidianKan MCP server with Podman.
# Requires Podman 3.x+. Tested on 3.4.4.
set -eu

IMAGE="obsidiankan-mcp:latest"
CONTAINER="obsidiankan-mcp"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Load .env
# ---------------------------------------------------------------------------
ENV_FILE="${SCRIPT_DIR}/.env"
if [ -f "$ENV_FILE" ]; then
  # Export only lines that look like KEY=value (skip comments and blanks)
  # shellcheck disable=SC2046
  export $(grep -v '^\s*#' "$ENV_FILE" | grep -v '^\s*$' | xargs)
fi

: "${VAULT_PATH:?VAULT_PATH is not set. Copy .env.example to .env and configure it.}"
: "${MCP_HTTP_PORT:=9375}"
: "${LOG_LEVEL:=info}"

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
cmd="${1:-help}"

case "$cmd" in

  build)
    echo "Building image ${IMAGE}..."
    podman build -t "$IMAGE" "$SCRIPT_DIR"
    echo "Done."
    ;;

  start)
    if podman container exists "$CONTAINER"; then
      echo "Container '${CONTAINER}' already exists. Run './container.sh stop' first."
      exit 1
    fi
    echo "Starting MCP server..."
    # --network=host: the server binds 127.0.0.1 inside its netns. Host networking
    # makes that the host loopback directly, so the server is reachable on
    # 127.0.0.1:${MCP_HTTP_PORT} and stays unreachable externally — no -p needed,
    # and the loopback-only /metrics guard keeps working. A published port
    # (-p) would NOT reach a 127.0.0.1-only listener inside the container.
    # --userns=keep-id maps the host user to the same uid inside the container,
    # and --user runs the process as that uid (not the image's baked-in 'node'
    # uid 1000). Together, everything written under /vault is owned by the host
    # user on disk — so the vault stays editable by hand and the host CLI and
    # container share one .kanban. Without --user the process would run as uid
    # 1000 and land on a subuid (e.g. 166536) the host user can't write.
    podman run -d \
      --name "$CONTAINER" \
      --restart unless-stopped \
      --userns=keep-id \
      --user "$(id -u):$(id -g)" \
      --network=host \
      -v "${VAULT_PATH}:/vault:z" \
      -e NODE_ENV=production \
      -e VAULT_PATH=/vault \
      -e MCP_HTTP_PORT="${MCP_HTTP_PORT}" \
      -e LOG_LEVEL="${LOG_LEVEL}"  \
      "$IMAGE"
    echo "MCP server running at http://localhost:${MCP_HTTP_PORT}"
    echo "Health: http://localhost:${MCP_HTTP_PORT}/health"
    ;;

  stop)
    echo "Stopping container '${CONTAINER}'..."
    podman stop "$CONTAINER" 2>/dev/null || true
    podman rm   "$CONTAINER" 2>/dev/null || true
    echo "Done."
    ;;

  restart)
    "$SCRIPT_DIR/container.sh" stop
    "$SCRIPT_DIR/container.sh" start
    ;;

  logs)
    podman logs -f "$CONTAINER"
    ;;

  status)
    if podman container exists "$CONTAINER"; then
      podman container inspect "$CONTAINER" \
        --format "status={{.State.Status}}  pid={{.State.Pid}}  started={{.State.StartedAt}}"
    else
      echo "Container '${CONTAINER}' is not running."
    fi
    ;;

  exec)
    # Pass remaining args to the container. Example:
    #   ./container.sh exec node src/index.js --stdio
    shift
    podman exec -it "$CONTAINER" "$@"
    ;;

  help|*)
    cat <<EOF
Usage: ./container.sh <command>

Commands:
  build      Build the container image from Dockerfile
  start      Create and start the MCP server container
  stop       Stop and remove the container (vault data on host is preserved)
  restart    Stop then start
  logs       Follow container logs (Ctrl-C to exit)
  status     Show container state
  exec ...   Run a command inside the running container
               e.g.: ./container.sh exec node src/index.js --stdio

Environment (set in .env, copied from .env.example):
  VAULT_PATH       Path to your Obsidian vault on the host  [required]
  MCP_HTTP_PORT    HTTP port for the MCP server              [default: 9375]
  LOG_LEVEL        debug | info | warn | error               [default: info]
EOF
    ;;

esac
