import { describe, expect, it } from 'vitest'
import type { Goal } from '@obsidiankan/types'
import { goalUrgency } from '../src/home/goal-urgency.js'
import { addDays } from '../src/util/time.js'

const TODAY = '2026-08-04'

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'goal-1',
    title: 'meta',
    target_date: null,
    status: 'open',
    created_at: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('goalUrgency', () => {
  it('sem data nunca é urgente', () => {
    expect(goalUrgency(goal(), TODAY)).toBe('ok')
  })

  it('data passada é overdue', () => {
    expect(goalUrgency(goal({ target_date: addDays(TODAY, -1) }), TODAY)).toBe('overdue')
  })

  it('hoje e até 7 dias é due-soon; o oitavo dia não é', () => {
    expect(goalUrgency(goal({ target_date: TODAY }), TODAY)).toBe('due-soon')
    expect(goalUrgency(goal({ target_date: addDays(TODAY, 7) }), TODAY)).toBe('due-soon')
    expect(goalUrgency(goal({ target_date: addDays(TODAY, 8) }), TODAY)).toBe('ok')
  })

  it('meta fechada não alerta, mesmo vencida', () => {
    expect(goalUrgency(goal({ target_date: addDays(TODAY, -30), status: 'done' }), TODAY)).toBe('ok')
    expect(goalUrgency(goal({ target_date: addDays(TODAY, -30), status: 'dropped' }), TODAY)).toBe(
      'ok',
    )
  })
})
