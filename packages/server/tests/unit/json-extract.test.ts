import { describe, it, expect } from 'vitest'
import { extractJson } from '../../src/planning/json-extract.js'

describe('extractJson', () => {
  it('parseia JSON puro', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('remove cerca de código ```json', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('ignora prosa antes e depois do objeto', () => {
    expect(extractJson('Claro! Aqui está:\n{"a":{"b":2}}\nEspero que ajude.')).toEqual({
      a: { b: 2 },
    })
  })

  it('balanceia chaves dentro de strings', () => {
    expect(extractJson('{"texto":"tem { e } dentro","n":1}')).toEqual({
      texto: 'tem { e } dentro',
      n: 1,
    })
  })

  it('escapes dentro de strings não quebram o balanceamento', () => {
    expect(extractJson('{"s":"aspas \\" e barra \\\\"}')).toEqual({ s: 'aspas " e barra \\' })
  })

  it('sem objeto nenhum → erro descritivo', () => {
    expect(() => extractJson('não há json aqui')).toThrow(/nenhum objeto JSON/)
  })

  it('objeto truncado → erro descritivo', () => {
    expect(() => extractJson('{"a":1')).toThrow(/nenhum objeto JSON|malformado/)
  })
})
