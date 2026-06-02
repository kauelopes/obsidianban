#!/usr/bin/env bash
# Dispatch the DEV agent (headless) and return its parsed result.
#
# Bundled INSIDE the kanban-pm-agent skill so it travels with copy/paste into
# any project — paths resolve relative to this script, never to the repo.
#
# The PM calls this via Bash. The dev runs as its OWN process, authenticated
# with the dev token (KANBAN_DEV_TOKEN), so the board sees a distinct identity
# (assigned_to, cost) and the server enforces the dev scope. Never run the dev
# as a Claude subagent: a subagent shares the parent's token and would act on
# the board as the PM.
#
# Usage:  .claude/skills/kanban-pm-agent/spawn-dev.sh ["instruction for the dev"]
# Env:    KANBAN_DEV_TOKEN    dev token minted by the manager (required)
#         KANBAN_URL          kanban HTTP server base (default http://127.0.0.1:9375)
#                             — if you change it, keep dev.mcp.json's url in sync
#         RESUME_SESSION_ID   (optional) resume the same dev session — see below
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KANBAN_URL="${KANBAN_URL:-http://127.0.0.1:9375}"

die() { echo "spawn-dev: $1" >&2; exit 1; }

# ── Prerequisites ─────────────────────────────────────────────────────────────
command -v claude >/dev/null 2>&1 || die "'claude' not on PATH (install Claude Code)."
command -v jq     >/dev/null 2>&1 || die "'jq' not installed — needed to parse the dev's JSON result."
[ -f "$SKILL_DIR/dev.mcp.json" ]     || die "missing $SKILL_DIR/dev.mcp.json (skill not fully copied?)."
[ -f "$SKILL_DIR/dev-settings.json" ] || die "missing $SKILL_DIR/dev-settings.json (skill not fully copied?)."

# ── Dev identity ──────────────────────────────────────────────────────────────
if [ -z "${KANBAN_DEV_TOKEN:-}" ]; then
  die "KANBAN_DEV_TOKEN not set. The dev needs its OWN token (agent_type=dev).
     Mint it with the manager:  kanban_create_agent_token { project, actor, agent_type: \"dev\" }
     then export the returned 'raw':  export KANBAN_DEV_TOKEN=<raw>"
fi

# ── Preflight: shared kanban server reachable? (skipped if curl is absent) ─────
if command -v curl >/dev/null 2>&1; then
  curl -fsS "$KANBAN_URL/health" >/dev/null 2>&1 \
    || die "kanban server not reachable at $KANBAN_URL/health — start the shared HTTP server or set KANBAN_URL."
fi

TASK="${1:-Work the active sprint until the todo column is empty. You are the \
DEV agent: pick_next -> claim -> in_progress -> execute -> log -> done. \
If blocked or proposing something: log + move the card to review, then continue.}"

# Resume: if RESUME_SESSION_ID is set, continue the SAME dev session (keeps the
# previous round's context) instead of starting fresh.
RESUME_ARGS=()
if [ -n "${RESUME_SESSION_ID:-}" ]; then
  RESUME_ARGS=(--resume "$RESUME_SESSION_ID")
  echo "spawn-dev: resuming session $RESUME_SESSION_ID" >&2
fi

# Run in the CALLER's cwd (the project) so the dev process auto-discovers that
# project's kanban-dev-agent skill. Config paths point at the skill bundle.
# --strict-mcp-config: dev sees ONLY the kanban server in dev.mcp.json.
# --settings:          denies the PM/manager skills (anti-confusion).
# --output-format json: single result object on stdout.
RAW="$(
  claude -p "$TASK" \
    "${RESUME_ARGS[@]}" \
    --strict-mcp-config \
    --mcp-config "$SKILL_DIR/dev.mcp.json" \
    --settings   "$SKILL_DIR/dev-settings.json" \
    --permission-mode acceptEdits \
    --output-format json \
    --name "kanban-dev"
)"

# Result object: is_error, result (dev's final text), session_id,
# total_cost_usd, num_turns, usage.{input_tokens,output_tokens}, duration_ms.
if [ "$(jq -r '.is_error' <<<"$RAW")" = "true" ]; then
  echo "DEV FAILED (subtype=$(jq -r '.subtype' <<<"$RAW")):" >&2
  jq -r '.result' <<<"$RAW" >&2
  exit 1
fi

jq -r '
  "── dev finished ──",
  "result    : \(.result)",
  "session   : \(.session_id)   (resume with: RESUME_SESSION_ID=\(.session_id))",
  "turns     : \(.num_turns)",
  "tokens    : in=\(.usage.input_tokens) out=\(.usage.output_tokens)",
  "cost USD  : \(.total_cost_usd)",
  "duration  : \(.duration_ms) ms"
' <<<"$RAW"
