import { describe, it, expect, beforeAll } from 'vitest'

// sprint-workflow.ts is a script, not a library: it reads required env vars
// (KANBAN_DEV_TOKEN, KANBAN_PM_TOKEN) at module load time and calls
// process.exit(2) if they're missing. Set harmless fake values before
// importing so the module loads cleanly under vitest — these are never used
// to make a real network call from this test (see the repo's placeholder
// KANBAN_*_TOKEN warning: never rely on ambient env values in tests).
process.env.KANBAN_DEV_TOKEN ??= 'test-dev-token'
process.env.KANBAN_PM_TOKEN ??= 'test-pm-token'

let findOrphanedCards: (cards: Array<Record<string, unknown>>) => Array<Record<string, unknown>>
let devRoundTimeoutMs: (minutesEnv: string | undefined) => number

beforeAll(async () => {
  // The module auto-runs main() only when executed directly (argv[1] check),
  // so importing it here for its exported pure helpers is side-effect free.
  const mod = await import('../../scripts/sprint-workflow.ts')
  findOrphanedCards = mod.findOrphanedCards
  devRoundTimeoutMs = mod.devRoundTimeoutMs
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
