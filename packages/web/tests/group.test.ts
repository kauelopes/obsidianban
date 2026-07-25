import { describe, it, expect } from 'vitest'
import type { CardSummary } from '@obsidiankan/types'
import {
  DEFAULT_COLUMN_ORDER,
  groupBoard,
  isOverdue,
  patchCard,
  removeCard,
  upsertCard,
} from '../src/board/group.js'

function card(over: Partial<CardSummary> = {}): CardSummary {
  return {
    id: 'card-1',
    project: 'p1',
    title: 'T',
    status: 'todo',
    type: 'task',
    version: 1,
    position: 1000,
    priority: 'medium',
    tags: [],
    due_date: null,
    assigned_to: null,
    owner: null,
    agent_notes: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'agent:pm',
    updated_by: 'agent:pm',
    archived: false,
    sprint_id: 's1',
    blocked_by: [],
    ...over,
  }
}

describe('DEFAULT_COLUMN_ORDER', () => {
  it("uses the server's canonical in_progress slug, not the plugin's in-progress", () => {
    expect(DEFAULT_COLUMN_ORDER).toContain('in_progress')
    expect(DEFAULT_COLUMN_ORDER).not.toContain('in-progress')
  })
})

describe('groupBoard', () => {
  it('groups by project and column, ordered by position', () => {
    const groups = groupBoard([
      card({ id: 'b', position: 2000 }),
      card({ id: 'a', position: 1000 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.cards['todo']!.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('sorts projects alphabetically', () => {
    const groups = groupBoard([card({ project: 'zeta' }), card({ project: 'alpha' })])
    expect(groups.map((g) => g.project)).toEqual(['alpha', 'zeta'])
  })

  it('renders a declared project with zero cards', () => {
    const groups = groupBoard([], [{ project: 'empty', columns: ['todo', 'done'] }])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.columns).toEqual(['todo', 'done'])
    expect(groups[0]!.cards['todo']).toEqual([])
  })

  it('appends unknown statuses so no card disappears', () => {
    const groups = groupBoard(
      [card({ status: 'limbo' })],
      [{ project: 'p1', columns: ['todo', 'done'] }],
    )
    expect(groups[0]!.columns).toEqual(['todo', 'done', 'limbo'])
    expect(groups[0]!.cards['limbo']).toHaveLength(1)
  })

  it('filters by the selected sprint', () => {
    const groups = groupBoard(
      [card({ id: 'in', sprint_id: 's1' }), card({ id: 'out', sprint_id: 's2' })],
      [{ project: 'p1', columns: ['todo'], selectedSprint: 's1' }],
    )
    expect(groups[0]!.cards['todo']!.map((c) => c.id)).toEqual(['in'])
  })

  it('shows every sprint when no filter is set', () => {
    const groups = groupBoard(
      [card({ id: 'a', sprint_id: 's1' }), card({ id: 'b', sprint_id: 's2', position: 2000 })],
      [{ project: 'p1', columns: ['todo'] }],
    )
    expect(groups[0]!.cards['todo']).toHaveLength(2)
  })
})

describe('incremental patches', () => {
  const list = [card({ id: 'a' }), card({ id: 'b' })]

  it('upsert replaces an existing card without reordering', () => {
    const out = upsertCard(list, card({ id: 'b', title: 'novo' }))
    expect(out).toHaveLength(2)
    expect(out[1]!.title).toBe('novo')
  })

  it('upsert appends an unknown card', () => {
    expect(upsertCard(list, card({ id: 'c' }))).toHaveLength(3)
  })

  it('patchCard touches only the target', () => {
    const out = patchCard(list, 'a', { status: 'done' })
    expect(out[0]!.status).toBe('done')
    expect(out[1]!.status).toBe('todo')
  })

  it('removeCard drops only the target', () => {
    expect(removeCard(list, 'a').map((c) => c.id)).toEqual(['b'])
  })

  it('never mutates the input array', () => {
    const before = JSON.stringify(list)
    upsertCard(list, card({ id: 'z' }))
    patchCard(list, 'a', { title: 'x' })
    removeCard(list, 'b')
    expect(JSON.stringify(list)).toBe(before)
  })
})

describe('isOverdue', () => {
  it('is false for a null due date', () => {
    expect(isOverdue(null, '2026-07-24')).toBe(false)
  })
  it('is false on the due date itself', () => {
    expect(isOverdue('2026-07-24', '2026-07-24')).toBe(false)
  })
  it('is true the day after', () => {
    expect(isOverdue('2026-07-23', '2026-07-24')).toBe(true)
  })
})
