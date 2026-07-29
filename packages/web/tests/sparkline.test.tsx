import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sparkline } from '../src/metrics/widgets.js'

const DAYS = [
  { date: '2026-07-23', card_ops: 4, commits: 2 },
  { date: '2026-07-24', card_ops: 0, commits: 0 },
  { date: '2026-07-25', card_ops: 1, commits: 0 },
]

describe('Sparkline', () => {
  it('empilha ops e commits, e dia vazio vira traço de base', () => {
    const { container } = render(<Sparkline days={DAYS} />)
    expect(container.querySelectorAll('.spark-ops')).toHaveLength(2)
    expect(container.querySelectorAll('.spark-commits')).toHaveLength(1)
    expect(container.querySelectorAll('.spark-idle')).toHaveLength(1)
  })

  it('cada dia carrega o breakdown exato no title', () => {
    const { container } = render(<Sparkline days={DAYS} />)
    const titles = [...container.querySelectorAll('title')].map((t) => t.textContent)
    expect(titles[0]).toBe('2026-07-23: 4 ops, 2 commits')
  })

  it('max externo domina a escala — barras comparáveis entre projetos', () => {
    const local = render(<Sparkline days={DAYS} />)
    const global = render(<Sparkline days={DAYS} max={60} />)
    const h = (c: HTMLElement) =>
      Number(c.querySelector('.spark-ops')?.getAttribute('height'))
    expect(h(global.container)).toBeLessThan(h(local.container))
  })

  it('dia com pouca atividade nunca arredonda para invisível', () => {
    const { container } = render(<Sparkline days={DAYS} max={1000} />)
    const rects = [...container.querySelectorAll('.spark-ops, .spark-commits')]
    for (const r of rects) {
      expect(Number(r.getAttribute('height'))).toBeGreaterThanOrEqual(2)
    }
  })
})
