// Sprint workflow — code-orchestrated sprint execution.
//
// This is a WORKFLOW (in the "Building Effective Agents" sense): the loop,
// sequencing, and termination are deterministic code; the LLM is invoked only
// where genuine judgment is required:
//
//   1. DEV execution  — the full Claude Code harness, spawned per round with
//                       the dev token. It carries the kanban_* MCP tools, the
//                       file/bash tools, and the kanban-dev-agent skill. We do
//                       NOT hand-roll a tool loop here — the harness is better
//                       at it (context management, caching, mature tools).
//   2. REVIEW triage  — hybrid: code returns blocker-cleared cards to todo;
//                       the LLM (pm token, scoped) only sees the ambiguous ones.
//
// The orchestration replaces the prompted-PM + the PM deciding the flow. The
// kanban server stays the single writer (DB + vault); every actor talks to it
// over HTTP, and identity is enforced server-side by token (dev vs pm).
//
// Run (kanban server up, an active sprint, .env filled):
//
//   node --import tsx scripts/sprint-workflow.ts
//
// Env:
//   ANTHROPIC_API_KEY        key for the triage LLM calls
//   KANBAN_DEV_TOKEN         dev token  (agent_type=dev)  minted by the manager
//   KANBAN_PM_TOKEN          pm  token  (agent_type=pm)   minted by the manager
//   KANBAN_URL               kanban HTTP base (default http://127.0.0.1:9375)
//   TARGET_REPO              dir the DEV harness works in (default cwd)
//   DEV_DRAIN_LIMIT          max cards a dev works per spawn (default 3; 1 = one
//                            card per round with exact per-card cost; larger ≈ drain)
//   DEV_MCP_CONFIG           override path to the dev MCP config (default: PM skill's)
//   DEV_SETTINGS             override path to the dev settings (default: PM skill's)
//   SPRINT_MAX_ROUNDS        loop safeguard (default 50)
//   RATE_LIMIT_WAIT_SECONDS  seconds to wait when credits run out (default 300).
//                            For the triage path the API retry-after header takes
//                            precedence when present. For the dev harness path the
//                            JSON result is matched against known limit messages
//                            ("You've hit your … limit").
//   RATE_LIMIT_MAX_RETRIES   max retries per operation before giving up (default 10)

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import Anthropic, { RateLimitError } from '@anthropic-ai/sdk'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'

// ── Config ─────────────────────────────────────────────────────────────────
try {
  process.loadEnvFile() // Node 22: load .env without a dependency
} catch {
  /* no .env file — rely on the ambient environment */
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')

const KANBAN_URL = process.env.KANBAN_URL ?? 'http://127.0.0.1:9375'
const DEV_TOKEN = required('KANBAN_DEV_TOKEN')
const PM_TOKEN = required('KANBAN_PM_TOKEN')
const TARGET_REPO = path.resolve(process.env.TARGET_REPO ?? process.cwd())
const MODEL = 'claude-opus-4-8'
const MAX_ROUNDS = Number(process.env.SPRINT_MAX_ROUNDS ?? 50)
const RATE_LIMIT_WAIT_MS = Number(process.env.RATE_LIMIT_WAIT_SECONDS ?? 300) * 1000
const RATE_LIMIT_MAX_RETRIES = Number(process.env.RATE_LIMIT_MAX_RETRIES ?? 10)
// Cards a dev works per spawn. 1 → one card per round (exact per-card cost);
// larger ≈ drain the todo until the limit, an empty todo, or a blocker.
const DEV_DRAIN_LIMIT = Math.max(1, Number(process.env.DEV_DRAIN_LIMIT ?? 3) || 3)

// The harness needs an MCP config (points the dev at the kanban server, injects
// the dev token) and a settings file (scopes the dev's tools/skills). Resolved
// from the workflow's repo root, NOT TARGET_REPO — the spawn's cwd is the repo
// being worked on, which may be elsewhere.
const DEV_MCP_CONFIG = process.env.DEV_MCP_CONFIG
  ?? path.join(REPO_ROOT, '.claude/skills/kanban-pm-agent/dev.mcp.json')
const DEV_SETTINGS = process.env.DEV_SETTINGS
  ?? path.join(REPO_ROOT, '.claude/skills/kanban-pm-agent/dev-settings.json')

// Opus 4.8 pricing ($/token) — used to price the triage API calls in USD.
const PRICE = { input: 5 / 1_000_000, output: 25 / 1_000_000 }

const client = new Anthropic() // reads ANTHROPIC_API_KEY from env

function required(name: string): string {
  const v = process.env[name]
  if (!v) {
    console.error(`error: ${name} is required (set it in .env)`)
    process.exit(2)
  }
  return v
}

// ── Kanban HTTP client (orchestrator + triage wrappers) ──────────────────────
interface ToolResult {
  status: number
  body: unknown
}

async function callTool(
  tool: string,
  params: Record<string, unknown>,
  token: string,
): Promise<ToolResult> {
  const res = await fetch(`${KANBAN_URL}/mcp/tool/${tool}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(params),
  })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = { error: 'invalid_json' }
  }
  return { status: res.status, body }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

// ── PM triage tools (model-facing, scoped subset) ────────────────────────────
function kanbanTool(
  name: string,
  description: string,
  shape: z.ZodRawShape,
  token: string,
  opts: { autoRequestId?: boolean } = {},
) {
  return betaZodTool({
    name,
    description,
    inputSchema: z.object(shape),
    run: async (input: Record<string, unknown>) => {
      const params: Record<string, unknown> = { ...input }
      if (opts.autoRequestId && params['request_id'] == null) params['request_id'] = randomUUID()
      return JSON.stringify(await callTool(name, params, token))
    },
  })
}

function pmTriageTools() {
  return [
    kanbanTool('kanban_list_cards', 'List cards in the active sprint. Optional filters.', {
      status: z.string().optional(), limit: z.number().int().optional(),
    }, PM_TOKEN),
    kanbanTool('kanban_get_card', 'Read one card incl. body and # Agent Log.', { id: z.string() }, PM_TOKEN),
    kanbanTool('kanban_move_card', 'Move a card to a column (todo to return it, done to close).', {
      id: z.string(), version: z.number().int(), to_status: z.string(),
    }, PM_TOKEN, { autoRequestId: true }),
    kanbanTool('kanban_update_card', 'Update card fields (e.g. clear blocked_by). Takes current version.', {
      id: z.string(), version: z.number().int(),
      blocked_by: z.array(z.string()).optional(), priority: z.string().optional(), agent_notes: z.string().optional(),
    }, PM_TOKEN, { autoRequestId: true }),
    kanbanTool('kanban_create_card', 'Create a follow-up card in the active sprint.', {
      title: z.string(), type: z.enum(['task', 'feature', 'bug', 'chore']), sprint_id: z.string(),
      priority: z.string().optional(), body: z.string().optional(), blocked_by: z.array(z.string()).optional(),
    }, PM_TOKEN, { autoRequestId: true }),
    kanbanTool('kanban_log_on_card', 'Append a timestamped entry to the # Agent Log.', {
      id: z.string(), version: z.number().int(), log_entry: z.string(),
    }, PM_TOKEN, { autoRequestId: true }),
  ]
}

// ── Token / cost accounting ──────────────────────────────────────────────────
interface Usage {
  input: number
  output: number
  usd: number
}

const sprintTotals: Usage & { devRuns: number; triageRuns: number } = {
  input: 0, output: 0, usd: 0, devRuns: 0, triageRuns: 0,
}

function accumulate(u: Usage): void {
  sprintTotals.input += u.input
  sprintTotals.output += u.output
  sprintTotals.usd += u.usd
}

// ── Rate-limit helpers ───────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The harness emits is_error=true with one of these messages when credits run out.
const RATE_LIMIT_RE = /hit your (session|weekly|daily|monthly|hourly) limit|rate.?limit|credits? (exhausted|insufficient)|too many requests/i

function isRateLimitResult(run: DevRun): boolean {
  return run.isError && RATE_LIMIT_RE.test(run.result)
}

// Extract retry-after seconds from an Anthropic SDK RateLimitError (if any),
// falling back to the configured default.
// headers is the fetch Headers type — use .get(), not bracket access.
function rateLimitWaitMs(err: RateLimitError): number {
  const raw = err.headers?.get('retry-after')
  return raw && Number(raw) > 0 ? Number(raw) * 1000 : RATE_LIMIT_WAIT_MS
}

// ── DEV runner: spawn the Claude Code harness ────────────────────────────────
interface DevRun {
  isError: boolean
  result: string
  sessionId?: string
  usage: Usage
  numTurns: number
}

// Thin marching order — the kanban-dev-agent skill (auto-loaded by the harness)
// already carries the full protocol; we only add granularity + a definition of
// done, and avoid repeating the skill (Opus 4.8 follows instructions literally).
function buildDevPrompt(limit: number): string {
  const scope = limit === 1
    ? 'Pick EXACTLY ONE ready card with kanban_pick_next, take it to "done" (or "review" if blocked or proposing follow-up), then STOP. Do not start a second card.'
    : `Work up to ${limit} ready cards. After finishing one, call kanban_pick_next for the next. STOP when ANY of these is true: you have completed ${limit} cards; kanban_pick_next returns no ready card; you are blocked or want to propose follow-up (log it and move that card to "review", then stop).`

  return `You are the DEV agent for the active sprint. Use the kanban_* tools plus your file and bash tools to do real work in this repository.

${scope}

For each card: kanban_claim_card, then kanban_move_card to "in_progress". Do the work. Run the relevant tests or build before completing — if none exist, say so in the log. kanban_log_on_card with a concrete summary (files changed, commands run, results). Then kanban_move_card to "done". If blocked or proposing: kanban_log_on_card with what you tried, what failed, and your recommendation, then kanban_move_card to "review".

Mutations take the card's current "version" — read it from the pick_next / get_card / move response and pass it back; on a 409 conflict re-read with kanban_get_card and retry. Do not invent token counts; omit them.`
}

function runClaudeDev(prompt: string): Promise<DevRun> {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--strict-mcp-config',
      '--mcp-config', DEV_MCP_CONFIG,
      '--settings', DEV_SETTINGS,
      '--permission-mode', 'acceptEdits',
      '--output-format', 'json',
      '--name', 'kanban-dev',
    ]
    const child = spawn('claude', args, {
      cwd: TARGET_REPO,
      env: { ...process.env, KANBAN_DEV_TOKEN: DEV_TOKEN },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('error', (err) =>
      resolve(failedRun(`spawn error: ${err.message} (is the 'claude' CLI on PATH?)`)),
    )
    child.on('close', () => {
      try {
        const j = asRecord(JSON.parse(stdout))
        const u = asRecord(j['usage'])
        resolve({
          isError: Boolean(j['is_error']),
          result: String(j['result'] ?? ''),
          sessionId: typeof j['session_id'] === 'string' ? j['session_id'] : undefined,
          usage: {
            input: Number(u['input_tokens'] ?? 0),
            output: Number(u['output_tokens'] ?? 0),
            usd: Number(j['total_cost_usd'] ?? 0),
          },
          numTurns: Number(j['num_turns'] ?? 0),
        })
      } catch {
        resolve(failedRun(`unparseable harness output: ${(stderr || stdout).slice(-500)}`))
      }
    })
  })
}

function failedRun(msg: string): DevRun {
  return { isError: true, result: msg, usage: { input: 0, output: 0, usd: 0 }, numTurns: 0 }
}

// Dispatch one dev round. Returns the cards that transitioned to done/review
// during the run (used for per-card cost attribution when DEV_DRAIN_LIMIT === 1).
// Retries automatically when the harness exits with a known credit-limit message.
async function runDev(sprintId: string): Promise<{ run: DevRun; moved: string[] }> {
  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const waitMin = Math.ceil(RATE_LIMIT_WAIT_MS / 60_000)
      log(`⏳ DEV: credits exhausted — waiting ${waitMin}min before retry (attempt ${attempt}/${RATE_LIMIT_MAX_RETRIES})`)
      await sleep(RATE_LIMIT_WAIT_MS)
    }

    // Take the settled snapshot fresh on every attempt — the board may have
    // changed if a previous attempt partially completed before hitting the limit.
    const before = DEV_DRAIN_LIMIT === 1 ? await settledSet(sprintId) : null
    log(`▶ DEV: working up to ${DEV_DRAIN_LIMIT} card(s)`)
    const run = await runClaudeDev(buildDevPrompt(DEV_DRAIN_LIMIT))

    if (isRateLimitResult(run)) continue

    sprintTotals.devRuns += 1
    accumulate(run.usage)

    if (run.isError) log(`  ⚠ dev run reported an error: ${run.result.slice(0, 200)}`)
    log(`◀ DEV done — in=${run.usage.input} out=${run.usage.output} $${run.usage.usd.toFixed(4)} (${run.numTurns} turns)`)

    const after = before ? await settledSet(sprintId) : new Set<string>()
    const moved = before ? [...after].filter((id) => !before.has(id)) : []
    return { run, moved }
  }

  throw new Error(`DEV: credit limit persisted after ${RATE_LIMIT_MAX_RETRIES} retries — give up.`)
}

// ── REVIEW triage (hybrid) ───────────────────────────────────────────────────
const autoReturned = new Map<string, number>()

// Code pass: a review card whose only obstacle was a blocker now done is
// returned to todo. Everything else is judgment → escalated to the LLM.
async function deterministicTriage(
  reviewCards: Array<Record<string, unknown>>,
  statusById: Map<string, string>,
): Promise<string[]> {
  const remaining: string[] = []
  for (const summary of reviewCards) {
    const id = String(summary['id'])
    const card = asRecord((await callTool('kanban_get_card', { id }, PM_TOKEN)).body)
    const blockedBy = Array.isArray(card['blocked_by']) ? (card['blocked_by'] as string[]) : []
    const cleared = blockedBy.length > 0 && blockedBy.every((b) => statusById.get(b) === 'done')

    if (cleared && (autoReturned.get(id) ?? 0) === 0) {
      await callTool('kanban_log_on_card',
        { id, version: Number(card['version']), log_entry: 'Blockers cleared — returned to todo by the workflow.', request_id: randomUUID() },
        PM_TOKEN)
      const after = asRecord((await callTool('kanban_get_card', { id }, PM_TOKEN)).body)
      await callTool('kanban_move_card',
        { id, version: Number(after['version']), to_status: 'todo', request_id: randomUUID() },
        PM_TOKEN)
      autoReturned.set(id, (autoReturned.get(id) ?? 0) + 1)
      log(`  ✓ triage(code): ${id} → todo (blockers cleared)`)
    } else {
      remaining.push(id)
    }
  }
  return remaining
}

const TRIAGE_SYSTEM = `You are the PM triaging the kanban "review" column. For each card given, read its # Agent Log with kanban_get_card and decide ONE of:
- CLOSE: the work is genuinely complete → kanban_move_card to "done".
- RETURN: the blocker is resolvable → fix it (e.g. kanban_update_card to clear blocked_by) and kanban_move_card to "todo".
- FOLLOW-UP: the dev proposed new work → kanban_create_card for it (use the active sprint_id given), then resolve the original card (done or todo).

Always kanban_log_on_card a one-line rationale. Mutations take the card's current "version"; on a 409 conflict re-read and retry. Triage every card you were given, then end your turn.`

async function triageReviewLLM(cardIds: string[], sprintId: string): Promise<void> {
  if (cardIds.length === 0) return

  for (let attempt = 0; attempt <= RATE_LIMIT_MAX_RETRIES; attempt++) {
    log(`▶ TRIAGE(llm): ${cardIds.length} ambiguous card(s)${attempt > 0 ? ` (retry ${attempt})` : ''}`)
    try {
      // Iterate the runner to sum usage across every turn (the awaited form would
      // only expose the final turn's usage).
      const runner = client.beta.messages.toolRunner({
        model: MODEL,
        max_tokens: 16_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        system: TRIAGE_SYSTEM,
        tools: pmTriageTools(),
        messages: [{ role: 'user', content: `Active sprint_id: ${sprintId}\nTriage these review cards: ${cardIds.join(', ')}` }],
      })

      const used: Usage = { input: 0, output: 0, usd: 0 }
      for await (const msg of runner) {
        used.input += msg.usage.input_tokens
        used.output += msg.usage.output_tokens
      }
      used.usd = used.input * PRICE.input + used.output * PRICE.output
      sprintTotals.triageRuns += 1
      accumulate(used)
      log(`◀ TRIAGE(llm) done — in=${used.input} out=${used.output} $${used.usd.toFixed(4)}`)
      return
    } catch (err) {
      if (err instanceof RateLimitError && attempt < RATE_LIMIT_MAX_RETRIES) {
        // Use the API's own retry-after when present; fall back to our default.
        const waitMs = rateLimitWaitMs(err)
        log(`⏳ TRIAGE: rate limit (429) — waiting ${Math.ceil(waitMs / 60_000)}min before retry (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`)
        await sleep(waitMs)
        continue
      }
      throw err
    }
  }

  throw new Error(`TRIAGE: rate limit persisted after ${RATE_LIMIT_MAX_RETRIES} retries — give up.`)
}

// ── Board reads (orchestrator, pm token) ─────────────────────────────────────
async function activeSprintId(): Promise<string | null> {
  const { body } = await callTool('kanban_list_sprints', { status: 'open' }, PM_TOKEN)
  const sprints = Array.isArray(asRecord(body)['sprints']) ? (asRecord(body)['sprints'] as Array<Record<string, unknown>>) : []
  const active = sprints.find((s) => s['status'] === 'active')
  return active ? String(active['id']) : null
}

async function statusMap(sprintId: string): Promise<Map<string, string>> {
  const { body } = await callTool('kanban_get_sprint', { sprint_id: sprintId }, PM_TOKEN)
  const cards = Array.isArray(asRecord(body)['cards']) ? (asRecord(body)['cards'] as Array<Record<string, unknown>>) : []
  return new Map(cards.map((c) => [String(c['id']), String(c['status'])]))
}

// Cards in a "settled" column (done or review) — the snapshot used to detect
// which card a dev acted on (for per-card cost when DEV_DRAIN_LIMIT === 1).
async function settledSet(sprintId: string): Promise<Set<string>> {
  const map = await statusMap(sprintId)
  const s = new Set<string>()
  for (const [id, st] of map) if (st === 'done' || st === 'review') s.add(id)
  return s
}

async function reviewCards(): Promise<Array<Record<string, unknown>>> {
  const { body } = await callTool('kanban_list_cards', { status: 'review' }, PM_TOKEN)
  const cards = asRecord(body)['cards']
  return Array.isArray(cards) ? (cards as Array<Record<string, unknown>>) : []
}

async function hasReadyCard(): Promise<boolean> {
  const { body } = await callTool('kanban_pick_next', {}, PM_TOKEN)
  return asRecord(body)['card'] != null
}

// Write the run's measured cost into the card's Agent Log (only when N === 1,
// where the run maps 1:1 to a card). Honest per-card cost, visible in Obsidian.
async function annotateCardCost(cardId: string, run: DevRun): Promise<void> {
  const card = asRecord((await callTool('kanban_get_card', { id: cardId }, PM_TOKEN)).body)
  await callTool('kanban_log_on_card', {
    id: cardId,
    version: Number(card['version']),
    log_entry: `💰 Workflow-measured cost — input=${run.usage.input} output=${run.usage.output} tokens, $${run.usage.usd.toFixed(4)} over ${run.numTurns} turns (model ${MODEL}).`,
    request_id: randomUUID(),
  }, PM_TOKEN)
}

async function printSprintSummary(sprintId: string): Promise<void> {
  const { body } = await callTool('kanban_get_sprint', { sprint_id: sprintId }, PM_TOKEN)
  const agg = asRecord(asRecord(body)['aggregates'])
  log('\n══ sprint summary ══')
  log(`board: total=${agg['cards_total']} done=${agg['cards_done']} in_progress=${agg['cards_in_progress']} todo=${agg['cards_todo']} other=${agg['cards_other']}`)
  log(`workflow-measured cost: in=${sprintTotals.input} out=${sprintTotals.output} tokens, $${sprintTotals.usd.toFixed(4)} (dev runs=${sprintTotals.devRuns}, triage runs=${sprintTotals.triageRuns})`)
}

// ── Orchestration loop (deterministic) ───────────────────────────────────────
async function main(): Promise<void> {
  if (KANBAN_URL !== 'http://127.0.0.1:9375') {
    log(`note: KANBAN_URL=${KANBAN_URL} — ensure ${DEV_MCP_CONFIG} 'url' matches, or the dev harness won't reach the server.`)
  }

  const health = await fetch(`${KANBAN_URL}/health`).catch(() => null)
  if (!health || !health.ok) {
    console.error(`error: kanban server not reachable at ${KANBAN_URL}/health`)
    process.exit(1)
  }

  const sprintId = await activeSprintId()
  if (!sprintId) {
    console.error('error: no active sprint. Start one (PM/manager) before running the workflow.')
    process.exit(1)
  }
  log(`sprint ${sprintId} active — target repo: ${TARGET_REPO} — drain limit: ${DEV_DRAIN_LIMIT}`)

  let round = 0
  while (round++ < MAX_ROUNDS) {
    log(`\n=== round ${round} ===`)

    // 1. Triage review before dispatching more dev work.
    const review = await reviewCards()
    if (review.length > 0) {
      const ambiguous = await deterministicTriage(review, await statusMap(sprintId))
      await triageReviewLLM(ambiguous, sprintId)
      continue
    }

    // 2. Dispatch a dev if there is a ready card.
    if (await hasReadyCard()) {
      const { run, moved } = await runDev(sprintId)
      // Per-card cost only when the run maps 1:1 to a card (N === 1).
      if (DEV_DRAIN_LIMIT === 1) {
        if (moved.length === 1) {
          await annotateCardCost(moved[0]!, run)
          log(`  💰 card ${moved[0]} cost recorded (in=${run.usage.input} out=${run.usage.output})`)
        } else {
          log(`  (per-card cost skipped: ${moved.length} card transitions this run)`)
        }
      }
      continue
    }

    // 3. review empty AND no ready card → sprint drained.
    log('sprint drained: review empty and no ready cards in todo.')
    break
  }

  if (round > MAX_ROUNDS) log(`stopped: hit MAX_ROUNDS=${MAX_ROUNDS} safeguard.`)
  await printSprintSummary(sprintId)
}

function log(msg: string): void {
  console.log(msg)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
