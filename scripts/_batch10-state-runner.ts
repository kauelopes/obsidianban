// Exercises pure state helpers used by the optimistic UI layer.
import {
  appendCard,
  patchCard,
  removeCard,
  replaceCard,
} from '../plugin/src/view/state.js'
import type { CardSummary } from '../src/types.js'

function pass(msg: string): void {
  console.log(`PASS|${msg}`)
}
function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function mkCard(overrides: Partial<CardSummary>): CardSummary {
  return {
    id: overrides.id ?? 'card-x',
    project: overrides.project ?? 'p1',
    title: overrides.title ?? 't',
    status: overrides.status ?? 'backlog',
    type: overrides.type ?? 'task',
    version: overrides.version ?? 1,
    position: overrides.position ?? 1000,
    priority: overrides.priority ?? 'medium',
    tags: overrides.tags ?? [],
    due_date: overrides.due_date ?? null,
    assigned_to: overrides.assigned_to ?? null,
    owner: overrides.owner ?? null,
    agent_notes: overrides.agent_notes ?? null,
    total_input_tokens: overrides.total_input_tokens ?? 0,
    total_output_tokens: overrides.total_output_tokens ?? 0,
    created_at: overrides.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00Z',
    created_by: overrides.created_by ?? 'a',
    updated_by: overrides.updated_by ?? 'a',
  }
}

function main(): void {
  const c1 = mkCard({ id: 'card-1' })
  const c2 = mkCard({ id: 'card-2', position: 2000 })
  const c3 = mkCard({ id: 'card-3', position: 3000 })
  const initial: ReadonlyArray<CardSummary> = [c1, c2, c3]

  // replaceCard
  const updated = mkCard({ id: 'card-2', title: 'updated' })
  const r = replaceCard(initial, updated)
  expect(r !== initial, 'replaceCard returns new array')
  expect(r[1]!.title === 'updated', 'card-2 replaced')
  expect(r[0] === c1 && r[2] === c3, 'other cards untouched')
  pass('replaceCard()')

  // patchCard
  const p = patchCard(initial, 'card-1', { status: 'in-progress', position: 9999 })
  expect(p[0]!.status === 'in-progress', 'status patched')
  expect(p[0]!.position === 9999, 'position patched')
  expect(p[0]!.title === c1.title, 'other fields preserved')
  expect(p[1] === c2 && p[2] === c3, 'other cards untouched')
  pass('patchCard() preserves other fields')

  // patchCard with unknown id is a no-op
  const np = patchCard(initial, 'card-missing', { status: 'whatever' })
  expect(np[0] === c1 && np[1] === c2 && np[2] === c3, 'no-op when id not found')
  pass('patchCard() no-op for unknown id')

  // appendCard
  const c4 = mkCard({ id: 'card-4', position: 4000 })
  const a = appendCard(initial, c4)
  expect(a.length === 4 && a[3]!.id === 'card-4', 'card appended at end')
  expect(initial.length === 3, 'original input not mutated')
  pass('appendCard()')

  // removeCard
  const rm = removeCard(initial, 'card-2')
  expect(rm.length === 2 && rm.map((c) => c.id).join(',') === 'card-1,card-3', 'card removed by id')
  pass('removeCard()')

  // Rollback round-trip: snapshot, mutate, restore
  let cards: CardSummary[] = [...initial]
  const snapshot = cards
  cards = patchCard(cards, 'card-2', { status: 'done', position: Number.MAX_SAFE_INTEGER })
  expect(cards[1]!.status === 'done', 'optimistic mutation applied')
  cards = [...snapshot] // rollback
  expect(cards[1]!.status === 'backlog', 'rollback restored status')
  expect(cards[1]!.position === 2000, 'rollback restored position (ordering preserved)')
  pass('rollback preserves ordering after optimistic patch')
}

try {
  main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
