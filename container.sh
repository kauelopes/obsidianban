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
: "${MCP_HTTP_PORT:=3000}"
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
    if podman inspect "$CONTAINER" > /dev/null 2>&1; then
      echo "Container '${CONTAINER}' already exists. Run './container.sh stop' first."
      exit 1
    fi
    echo "Starting MCP server..."
    podman run -d \
      --name "$CONTAINER" \
      --restart unless-stopped \
      --userns=keep-id \
      -v "${VAULT_PATH}:/vault:z" \
      -p "127.0.0.1:${MCP_HTTP_PORT}:3000" \
      -e NODE_ENV=production \
      -e VAULT_PATH=/vault \
      -e MCP_HTTP_PORT=3000 \
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
    if podman inspect "$CONTAINER" > /dev/null 2>&1; then
      podman inspect "$CONTAINER" \
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
  MCP_HTTP_PORT    HTTP port for the MCP server              [default: 3000]
  LOG_LEVEL        debug | info | warn | error               [default: info]
EOF
    ;;

esac
