import { describe, expect, it } from 'vitest'
import { clusterSessions } from '../../src/services/activity.js'

const MIN = 60_000
const GAP = 30 * MIN
const FLOOR = 10 * MIN

describe('clusterSessions', () => {
  it('sem eventos, zero', () => {
    expect(clusterSessions([])).toBe(0)
  })

  it('evento isolado conta o piso, não zero', () => {
    expect(clusterSessions([1_000_000])).toBe(FLOOR)
  })

  it('eventos próximos formam uma sessão do primeiro ao último', () => {
    const t0 = 0
    expect(clusterSessions([t0, t0 + 20 * MIN, t0 + 45 * MIN])).toBe(45 * MIN)
  })

  it('gap igual ao limite separa sessões', () => {
    // Duas sessões de evento único: 2 × piso.
    expect(clusterSessions([0, GAP])).toBe(2 * FLOOR)
  })

  it('gap logo abaixo do limite mantém a sessão', () => {
    expect(clusterSessions([0, GAP - 1])).toBe(GAP - 1)
  })

  it('ordem de chegada não importa', () => {
    const shuffled = [50 * MIN, 0, 20 * MIN]
    expect(clusterSessions(shuffled)).toBe(clusterSessions([...shuffled].sort((a, b) => a - b)))
  })

  it('sessão curta entre eventos reais também respeita o piso', () => {
    // Dois eventos a 2min: duração real 2min < piso 10min.
    expect(clusterSessions([0, 2 * MIN])).toBe(FLOOR)
  })
})
