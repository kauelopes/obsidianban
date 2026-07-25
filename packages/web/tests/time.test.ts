import { describe, expect, it } from 'vitest'
import { relativeTime } from '../src/util/time.js'

const NOW = new Date('2026-07-25T12:00:00Z')

describe('relativeTime', () => {
  it('escala a unidade com a distância', () => {
    expect(relativeTime('2026-07-25T11:59:30Z', NOW)).toBe('agora')
    expect(relativeTime('2026-07-25T11:45:00Z', NOW)).toBe('há 15 min')
    expect(relativeTime('2026-07-25T09:00:00Z', NOW)).toBe('há 3 h')
    expect(relativeTime('2026-07-24T11:00:00Z', NOW)).toBe('há 1 dia')
    expect(relativeTime('2026-07-01T12:00:00Z', NOW)).toBe('há 24 dias')
  })

  it('string que não parseia volta como veio', () => {
    expect(relativeTime('ontem de tarde', NOW)).toBe('ontem de tarde')
  })
})
