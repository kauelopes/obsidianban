import { describe, expect, it } from 'vitest'
import type { Goal } from '@obsidiankan/types'
import {
  classifyGoal,
  compareHorizonItem,
  datedGoals,
  groupGoalsByHorizon,
} from '../src/horizon/horizon.js'
import { buildMonthGrid, monthLabel, shiftMonth } from '../src/horizon/calendar.js'
import { addDays, diffDays, mondayOf } from '../src/util/time.js'

const TODAY = '2026-08-04' // uma terça-feira

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

describe('classifyGoal', () => {
  it('sem data cai em undated, não em longo prazo', () => {
    expect(classifyGoal(goal({ target_date: null }), TODAY)).toBe('undated')
  })

  it('vencer hoje ainda é curto prazo — o dia não acabou', () => {
    expect(classifyGoal(goal({ target_date: TODAY }), TODAY)).toBe('short')
  })

  it('ontem é atraso', () => {
    expect(classifyGoal(goal({ target_date: addDays(TODAY, -1) }), TODAY)).toBe('overdue')
  })

  it('fronteiras de 14 e 28 dias', () => {
    expect(classifyGoal(goal({ target_date: addDays(TODAY, 14) }), TODAY)).toBe('short')
    expect(classifyGoal(goal({ target_date: addDays(TODAY, 15) }), TODAY)).toBe('medium')
    expect(classifyGoal(goal({ target_date: addDays(TODAY, 28) }), TODAY)).toBe('medium')
    expect(classifyGoal(goal({ target_date: addDays(TODAY, 29) }), TODAY)).toBe('long')
  })

  it('não depende do horário de verão entre as datas', () => {
    // Brasil já não tem DST, mas o navegador do usuário pode estar em fuso que
    // tem — o cálculo é em UTC puro justamente para não errar por 1 dia aqui.
    expect(diffDays('2026-10-01', '2026-11-01')).toBe(31)
  })
})

describe('groupGoalsByHorizon', () => {
  const projects = [
    {
      project: 'alpha',
      goals: [
        goal({ id: 'a1', title: 'atrasada', target_date: addDays(TODAY, -3) }),
        goal({ id: 'a2', title: 'concluída', target_date: TODAY, status: 'done' }),
        goal({ id: 'a3', title: 'abandonada', target_date: TODAY, status: 'dropped' }),
      ],
    },
    {
      project: 'beta',
      goals: [
        goal({ id: 'b1', title: 'longe', target_date: addDays(TODAY, 60) }),
        goal({ id: 'b2', title: 'logo', target_date: addDays(TODAY, 2) }),
        goal({ id: 'b3', title: 'sem prazo' }),
      ],
    },
  ]

  it('agrega projetos na ordem de urgência e ignora done/dropped', () => {
    const groups = groupGoalsByHorizon(projects, TODAY)
    expect(groups.map((g) => g.bucket)).toEqual(['overdue', 'short', 'long', 'undated'])
    expect(groups.flatMap((g) => g.items.map((i) => i.goal.id))).toEqual(['a1', 'b2', 'b1', 'b3'])
  })

  it('carrega o projeto de origem em cada item', () => {
    const groups = groupGoalsByHorizon(projects, TODAY)
    expect(groups[0]!.items[0]!.project).toBe('alpha')
  })

  it('grupos vazios não aparecem e lista vazia devolve nada', () => {
    expect(groupGoalsByHorizon([{ project: 'x', goals: [] }], TODAY)).toEqual([])
    expect(groupGoalsByHorizon([{ project: 'x' }], TODAY)).toEqual([])
  })

  it('ordena por data dentro do grupo, e por título quando não há data', () => {
    const groups = groupGoalsByHorizon(
      [
        {
          project: 'x',
          goals: [
            goal({ id: 'g2', title: 'depois', target_date: addDays(TODAY, 10) }),
            goal({ id: 'g1', title: 'antes', target_date: addDays(TODAY, 1) }),
            goal({ id: 'z', title: 'zebra' }),
            goal({ id: 'a', title: 'abacaxi' }),
          ],
        },
      ],
      TODAY,
    )
    expect(groups[0]!.items.map((i) => i.goal.id)).toEqual(['g1', 'g2'])
    expect(groups[1]!.items.map((i) => i.goal.id)).toEqual(['a', 'z'])
  })

  it('compareHorizonItem desempata datas iguais pelo título', () => {
    const a = { project: 'p', goal: goal({ title: 'b', target_date: TODAY }) }
    const b = { project: 'p', goal: goal({ title: 'a', target_date: TODAY }) }
    expect(compareHorizonItem(a, b)).toBeGreaterThan(0)
  })
})

describe('datedGoals', () => {
  it('só metas abertas e com data', () => {
    const items = datedGoals([
      {
        project: 'p',
        goals: [
          goal({ id: 'com', target_date: TODAY }),
          goal({ id: 'sem' }),
          goal({ id: 'feita', target_date: TODAY, status: 'done' }),
        ],
      },
    ])
    expect(items.map((i) => i.goal.id)).toEqual(['com'])
  })
})

describe('buildMonthGrid', () => {
  it('sempre 42 células começando numa segunda', () => {
    const grid = buildMonthGrid(2026, 7, [], TODAY)
    expect(grid).toHaveLength(42)
    expect(grid[0]!.date).toBe(mondayOf('2026-08-01'))
  })

  it('marca inMonth só nos dias do mês exibido', () => {
    const grid = buildMonthGrid(2026, 7, [], TODAY)
    const inMonth = grid.filter((c) => c.inMonth)
    expect(inMonth).toHaveLength(31)
    expect(inMonth[0]!.date).toBe('2026-08-01')
    expect(inMonth.at(-1)!.date).toBe('2026-08-31')
  })

  it('cobre fevereiro de ano bissexto', () => {
    const grid = buildMonthGrid(2028, 1, [], TODAY)
    expect(grid.filter((c) => c.inMonth)).toHaveLength(29)
  })

  it('isToday marca no máximo uma célula, e nenhuma em outro mês', () => {
    expect(buildMonthGrid(2026, 7, [], TODAY).filter((c) => c.isToday)).toHaveLength(1)
    expect(buildMonthGrid(2027, 0, [], TODAY).filter((c) => c.isToday)).toHaveLength(0)
  })

  it('planta as metas no dia da data-alvo', () => {
    const g = { project: 'p', goal: goal({ target_date: '2026-08-20' }) }
    const outro = { project: 'p', goal: goal({ id: 'g2', target_date: '2026-08-20' }) }
    const grid = buildMonthGrid(2026, 7, [g, outro], TODAY)
    expect(grid.find((c) => c.date === '2026-08-20')!.items).toHaveLength(2)
    expect(grid.filter((c) => c.items.length > 0)).toHaveLength(1)
  })
})

describe('shiftMonth', () => {
  it('cruza a virada do ano nos dois sentidos', () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 })
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 })
  })

  it('monthLabel nomeia o mês em pt-BR', () => {
    expect(monthLabel(2026, 7)).toContain('agosto')
  })
})
