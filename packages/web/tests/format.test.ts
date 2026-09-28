import { describe, expect, it } from 'vitest'
import { fmtCompact } from '../src/util/format.js'

describe('fmtCompact', () => {
  it('abrevia por unidade, com uma casa decimal só abaixo de 10', () => {
    expect(fmtCompact(999)).toBe('999')
    expect(fmtCompact(1_200)).toBe('1.2K')
    expect(fmtCompact(12_500)).toBe('13K')
    expect(fmtCompact(3_400_000)).toBe('3.4M')
    expect(fmtCompact(2_000_000_000)).toBe('2B')
  })

  it('promove a unidade quando o arredondamento chegaria a 1000', () => {
    expect(fmtCompact(999_500)).toBe('1M')
    expect(fmtCompact(999_999)).toBe('1M')
    expect(fmtCompact(999_999_999)).toBe('1B')
  })

  it('preserva o sinal', () => {
    expect(fmtCompact(-1_500)).toBe('-1.5K')
  })
})
