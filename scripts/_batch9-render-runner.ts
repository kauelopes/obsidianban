// Runner exercised by smoke-batch9.mjs via tsx. Tests the pure render layer
// (groupBoard, isOverdue, todayString). DOM rendering itself requires a live
// Obsidian instance, so we only exercise the grouping/sorting logic here.
import { groupBoard, isOverdue, todayString } from '../plugin/src/view/render.js'
import type { CardSummary } from '../src/types.js'

function pass(msg: string): void {
  console.log(`PASS|${msg}`)
}
function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function card(overrides: Partial<CardSummary>): CardSummary {
  return {
    id: overrides.id ?? 'card-xxx',
    project: overrides.project ?? 'p1',
    title: overrides.title ?? 'untitled',
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
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
    created_by: overrides.created_by ?? 'agent:test',
    updated_by: overrides.updated_by ?? 'agent:test',
  }
}

function main(): void {
  // Test 1: empty input → empty groups
  expect(groupBoard([]).length === 0, 'empty cards → empty groups')
  pass('groupBoard([]) = []')

  // Test 2: single card in single project
  const g1 = groupBoard([card({ id: 'card-a', project: 'p1', status: 'todo', position: 1000 })])
  expect(g1.length === 1, '1 project group')
  expect(g1[0]!.project === 'p1', 'project name preserved')
  expect(g1[0]!.columns.includes('todo'), 'todo column present')
  expect(g1[0]!.cards['todo']!.length === 1, 'card in todo column')
  pass('single project, single card')

  // Test 3: default column order: backlog, todo, in-progress, review, done
  const g3 = groupBoard([
    card({ id: 'card-1', project: 'p1', status: 'done' }),
    card({ id: 'card-2', project: 'p1', status: 'backlog' }),
    card({ id: 'card-3', project: 'p1', status: 'review' }),
    card({ id: 'card-4', project: 'p1', status: 'in-progress' }),
    card({ id: 'card-5', project: 'p1', status: 'todo' }),
  ])
  const cols = g3[0]!.columns
  expect(cols[0] === 'backlog', `cols[0] = backlog (got ${cols[0]})`)
  expect(cols[1] === 'todo', `cols[1] = todo (got ${cols[1]})`)
  expect(cols[2] === 'in-progress', `cols[2] = in-progress (got ${cols[2]})`)
  expect(cols[3] === 'review', `cols[3] = review (got ${cols[3]})`)
  expect(cols[4] === 'done', `cols[4] = done (got ${cols[4]})`)
  pass('default column order backlog→todo→in-progress→review→done')

  // Test 4: unknown statuses appended at end
  const g4 = groupBoard([
    card({ id: 'card-a', project: 'p1', status: 'archived' }),
    card({ id: 'card-b', project: 'p1', status: 'backlog' }),
  ])
  expect(g4[0]!.columns[g4[0]!.columns.length - 1] === 'archived', 'unknown status at end')
  pass('unknown status appended after defaults')

  // Test 5: cards within column sorted by position ASC
  const g5 = groupBoard([
    card({ id: 'card-c', project: 'p1', status: 'backlog', position: 3000 }),
    card({ id: 'card-a', project: 'p1', status: 'backlog', position: 1000 }),
    card({ id: 'card-b', project: 'p1', status: 'backlog', position: 2000 }),
  ])
  const ids = g5[0]!.cards['backlog']!.map((c) => c.id)
  expect(JSON.stringify(ids) === JSON.stringify(['card-a', 'card-b', 'card-c']), `position ASC: ${JSON.stringify(ids)}`)
  pass('cards within column sorted by position ASC')

  // Test 6: multiple projects sorted alphabetically
  const g6 = groupBoard([
    card({ id: 'card-z', project: 'zeta' }),
    card({ id: 'card-a', project: 'alpha' }),
    card({ id: 'card-m', project: 'mu' }),
  ])
  expect(g6.map((p) => p.project).join(',') === 'alpha,mu,zeta', `project order: ${g6.map((p) => p.project).join(',')}`)
  pass('projects sorted alphabetically')

  // Test 7: empty default columns are still in the column list (so UI shows them)
  const g7 = groupBoard([card({ id: 'card-a', project: 'p1', status: 'todo' })])
  expect(g7[0]!.columns.includes('backlog'), 'empty backlog column still listed')
  expect(g7[0]!.cards['backlog']!.length === 0, 'empty backlog → []')
  pass('empty default columns rendered as empty arrays')

  // Test 8: overdue detection
  expect(isOverdue('2026-01-01', '2026-05-27') === true, 'past date → overdue')
  expect(isOverdue('2026-05-27', '2026-05-27') === false, 'same day → not overdue')
  expect(isOverdue('2026-12-01', '2026-05-27') === false, 'future date → not overdue')
  expect(isOverdue(null, '2026-05-27') === false, 'null due_date → not overdue')
  pass('isOverdue() lexicographic compare correct')

  // Test 9: todayString format
  const today = todayString(new Date(2026, 4, 27)) // May 27 2026 (month 0-indexed)
  expect(today === '2026-05-27', `todayString = 2026-05-27 (got ${today})`)
  pass('todayString() formats YYYY-MM-DD')

  // Test 10: project-level isolation — cards from project A don't appear in project B
  const g10 = groupBoard([
    card({ id: 'card-a', project: 'a', status: 'backlog' }),
    card({ id: 'card-b', project: 'b', status: 'backlog' }),
  ])
  expect(g10.length === 2, 'two project groups')
  expect(g10[0]!.cards['backlog']![0]!.id === 'card-a', 'a has card-a only')
  expect(g10[1]!.cards['backlog']![0]!.id === 'card-b', 'b has card-b only')
  pass('cards isolated per project')
}

try {
  main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
