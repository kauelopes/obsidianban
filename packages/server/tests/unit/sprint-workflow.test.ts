import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// sprint-workflow.ts is a script, not a library: it reads required env vars
// (KANBAN_DEV_TOKEN, KANBAN_PM_TOKEN) at module load time and calls
// process.exit(2) if they're missing. Set harmless fake values before
// importing so the module loads cleanly under vitest — these are never used
// to make a real network call from this test (see the repo's placeholder
// KANBAN_*_TOKEN warning: never rely on ambient env values in tests).
process.env.KANBAN_DEV_TOKEN ??= 'test-dev-token'
process.env.KANBAN_PM_TOKEN ??= 'test-pm-token'

// main() spawns the `claude` CLI (node:child_process) once per round. Mocked
// here so the "3 consecutive dev failures" scenario below can be driven
// end-to-end without a real harness. Declared with vi.hoisted so the
// vi.mock factory (hoisted above all imports by vitest) can reference it.
const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn: spawnMock }))

let findOrphanedCards: (cards: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
let devRoundTimeoutMs: (minutesEnv: string | undefined) => number
let main: () => Promise<void>

beforeAll(async () => {
  // The module auto-runs main() only when executed directly (argv[1] check),
  // so importing it here for its exported pure helpers/main is side-effect free.
  const mod = await import('../../scripts/sprint-workflow.ts')
  findOrphanedCards = mod.findOrphanedCards
  devRoundTimeoutMs = mod.devRoundTimeoutMs
  main = mod.main
})

describe('findOrphanedCards', () => {
  it('returns in_progress cards without a job: assignee', () => {
    const cards = [
      { id: 'c1', status: 'in_progress', assigned_to: 'dev-token-abc' },
      { id: 'c2', status: 'in_progress', assigned_to: 'job:worker-1' },
      { id: 'c3', status: 'todo', assigned_to: null },
      { id: 'c4', status: 'in_progress', assigned_to: null },
      { id: 'c5', status: 'done', assigned_to: 'dev-token-xyz' },
    ]
    const orphans = findOrphanedCards(cards)
    expect(orphans.map((c) => c['id'])).toEqual(['c1', 'c4'])
  })

  it('treats a job: prefix as untouchable regardless of suffix', () => {
    const cards = [
      { id: 'c1', status: 'in_progress', assigned_to: 'job:' },
      { id: 'c2', status: 'in_progress', assigned_to: 'job:abcdef123' },
    ]
    expect(findOrphanedCards(cards)).toEqual([])
  })

  it('ignores non-in_progress cards entirely', () => {
    const cards = [
      { id: 'c1', status: 'review', assigned_to: 'dev-token' },
      { id: 'c2', status: 'todo', assigned_to: null },
    ]
    expect(findOrphanedCards(cards)).toEqual([])
  })

  it('is a pure function — no mutation of the input array', () => {
    const cards = [{ id: 'c1', status: 'in_progress', assigned_to: 'x' }]
    const copy = JSON.parse(JSON.stringify(cards))
    findOrphanedCards(cards)
    expect(cards).toEqual(copy)
  })
})

describe('devRoundTimeoutMs', () => {
  it('defaults to 45 minutes when unset', () => {
    expect(devRoundTimeoutMs(undefined)).toBe(45 * 60_000)
  })

  it('reads minutes from the env string', () => {
    expect(devRoundTimeoutMs('10')).toBe(10 * 60_000)
  })

  it('falls back to the default on garbage input', () => {
    expect(devRoundTimeoutMs('not-a-number')).toBe(45 * 60_000)
    expect(devRoundTimeoutMs('0')).toBe(45 * 60_000)
    expect(devRoundTimeoutMs('-5')).toBe(45 * 60_000)
  })
})

// Regression test for the review finding: the 3-consecutive-dev-failures
// abort throws out of main()'s round loop. Before the fix, that throw
// propagated straight to main()'s caller and skipped both the per-round
// sweepOrphanedInProgress call (never reached because the throw happens
// before it) AND the sweep that used to sit right after the loop (never
// reached because a throw doesn't fall through to code after the loop) —
// reproducing the exact incident this task exists to prevent: an orphaned
// in_progress card left behind when the workflow aborts. The fix wraps the
// loop in try/finally so the sweep always runs, including on this path.
describe('main() — orphan sweep survives the 3-consecutive-dev-failures abort', () => {
  function jsonResponse(body: unknown, status = 200): Response {
    return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
  }

  const moveCardCalls: Array<{ id: string; to_status: string }> = []

  function fetchRouter(url: string | URL, init?: RequestInit): Promise<Response> {
    const u = String(url)
    if (u.endsWith('/health')) return Promise.resolve(jsonResponse({}))
    const match = u.match(/\/mcp\/tool\/(\w+)$/)
    if (!match) return Promise.resolve(jsonResponse({ error: `unexpected url: ${u}` }, 500))
    const tool = match[1]
    const params = init?.body ? JSON.parse(String(init.body)) : {}
    switch (tool) {
      case 'kanban_list_sprints':
        return Promise.resolve(jsonResponse({ sprints: [{ id: 'sprint-1', status: 'active' }] }))
      case 'kanban_list_cards':
        return Promise.resolve(jsonResponse({ cards: [] })) // review column always empty in this scenario
      case 'kanban_pick_next':
        return Promise.resolve(jsonResponse({ card: { id: 'ready-card' } })) // always a ready card → always dispatch dev
      case 'kanban_get_sprint':
        return Promise.resolve(jsonResponse({
          cards: [{ id: 'orphan-1', status: 'in_progress', assigned_to: 'stale-dev-token' }],
          aggregates: {},
        }))
      case 'kanban_get_card':
        return Promise.resolve(jsonResponse({ id: params['id'], version: 1, assigned_to: 'stale-dev-token' }))
      case 'kanban_log_on_card':
      case 'kanban_update_card':
        return Promise.resolve(jsonResponse({ ok: true }))
      case 'kanban_move_card':
        moveCardCalls.push({ id: String(params['id']), to_status: String(params['to_status']) })
        return Promise.resolve(jsonResponse({ ok: true }))
      default:
        return Promise.resolve(jsonResponse({ error: `unhandled tool: ${tool}` }, 500))
    }
  }

  // A fake `claude` harness child process whose stream-json result reports
  // is_error: true with zero usage (so reportRoundUsage's no-op-on-zero
  // short-circuit means we don't also need to mock kanban_log_workflow_usage).
  function makeFailingDevChild() {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (sig?: string) => boolean; pid: number }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = vi.fn(() => true)
    child.pid = 4242
    const resultLine = JSON.stringify({
      type: 'result',
      is_error: true,
      result: 'simulated dev failure',
      num_turns: 1,
      session_id: 's1',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      modelUsage: {},
      total_cost_usd: 0,
    })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from(`${resultLine}\n`))
      child.emit('close')
    })
    return child
  }

  beforeEach(() => {
    moveCardCalls.length = 0
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => makeFailingDevChild())
    vi.stubGlobal('fetch', vi.fn(fetchRouter))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sweeps the orphaned card even though the abort throws out of the loop', async () => {
    await expect(main()).rejects.toThrow(/DEV failed 3 rounds in a row/)

    const orphanTodoMoves = moveCardCalls.filter((c) => c.id === 'orphan-1' && c.to_status === 'todo')
    // Round 1 and round 2 each fail (not yet aborting) and run their normal
    // per-round sweep → 2 moves. Round 3 hits the 3rd consecutive failure and
    // throws BEFORE its own per-round sweep call — that 3rd move only exists
    // because of the try/finally around the loop. Without the fix this would
    // be 2, not 3.
    expect(orphanTodoMoves.length).toBe(3)
  })
})
