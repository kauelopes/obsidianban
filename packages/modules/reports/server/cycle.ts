import type { CardMove } from '@obsidiankan/module-sdk'

const HOUR_MS = 3_600_000

export interface Percentiles {
  count: number
  p50: number
  p90: number
  max: number
}

/** Mesma definição do FlowService do core: p50/p90/max em horas, zeros sem amostra. */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { count: 0, p50: 0, p90: 0, max: 0 }
  const xs = [...values].sort((a, b) => a - b)
  const at = (q: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.ceil(xs.length * q) - 1))]!
  const r2 = (n: number) => Math.round(n * 100) / 100
  return { count: xs.length, p50: r2(at(0.5)), p90: r2(at(0.9)), max: r2(xs.at(-1)!) }
}

export interface CardFlow {
  /** Horas de cada ciclo in_progress → done do card. */
  cycles: number[]
  /** Horas paradas em review até sair. */
  reviewWaits: number[]
  /** Último MOVE para done, se houve. */
  doneAt: string | null
  /** Voltas de coluna (retrabalho), pela ordem de colunas do projeto. */
  backward: number
  forward: number
}

/**
 * Relê os MOVEs de um conjunto de cards com a mesma regra do FlowService:
 * primeiro in_progress abre o relógio, done fecha (e reabre num segundo ciclo);
 * a espera em review termina no próximo MOVE, para onde for.
 */
export function flowByCard(moves: readonly CardMove[], columns: readonly string[]): Map<string, CardFlow> {
  const byCard = new Map<string, CardMove[]>()
  for (const m of moves) {
    const list = byCard.get(m.card_id)
    if (list) list.push(m)
    else byCard.set(m.card_id, [m])
  }
  const out = new Map<string, CardFlow>()
  for (const [id, list] of byCard) {
    list.sort((a, b) => a.ts.localeCompare(b.ts))
    const f: CardFlow = { cycles: [], reviewWaits: [], doneAt: null, backward: 0, forward: 0 }
    let startedAt: number | null = null
    let reviewAt: number | null = null
    for (const m of list) {
      const ms = Date.parse(m.ts)
      if (m.to_status === 'in_progress' && startedAt === null) startedAt = ms
      if (m.to_status === 'done') {
        f.doneAt = m.ts
        if (startedAt !== null) {
          f.cycles.push((ms - startedAt) / HOUR_MS)
          startedAt = null
        }
      }
      if (m.to_status === 'review') reviewAt = ms
      else if (reviewAt !== null) {
        f.reviewWaits.push((ms - reviewAt) / HOUR_MS)
        reviewAt = null
      }
      const from = columns.indexOf(m.from_status)
      const to = columns.indexOf(m.to_status)
      if (from >= 0 && to >= 0 && from !== to) {
        if (to < from) f.backward++
        else f.forward++
      }
    }
    out.set(id, f)
  }
  return out
}
