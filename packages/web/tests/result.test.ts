import { describe, it, expect } from 'vitest'
import { errorText, toMcpResult } from '../src/api/result.js'

describe('toMcpResult', () => {
  it('unwraps a 200 into ok', () => {
    const r = toMcpResult<{ a: number }>(200, { a: 1 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.a).toBe(1)
  })

  it('maps a 409 to conflict, preserving the server-authoritative card', () => {
    const r = toMcpResult(409, {
      message: 'Version mismatch',
      your_version: 3,
      current_version: 4,
      conflicting_fields: ['body'],
      current_card: { id: 'card-1' },
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error.kind).toBe('conflict')
    if (r.error.kind !== 'conflict') return
    expect(r.error.yourVersion).toBe(3)
    expect(r.error.currentVersion).toBe(4)
    expect(r.error.conflictingFields).toEqual(['body'])
    expect(r.error.currentCard.id).toBe('card-1')
  })

  it('maps a 400 to validation with the field lists', () => {
    const r = toMcpResult(400, {
      message: 'disallowed',
      disallowed_fields: ['title'],
      allowed_fields: ['id', 'version', 'spec'],
    })
    if (r.ok) throw new Error('expected failure')
    expect(r.error.kind).toBe('validation')
    if (r.error.kind !== 'validation') return
    expect(r.error.disallowedFields).toEqual(['title'])
  })

  it('maps a 403 to server error, keeping the reason readable', () => {
    const r = toMcpResult(403, { error: 'forbidden', message: 'dev cannot rewrite # Spec' })
    if (r.ok) throw new Error('expected failure')
    expect(r.error.kind).toBe('server')
    expect(r.error.message).toBe('dev cannot rewrite # Spec')
  })

  it('falls back to http_<status> when the body carries no message', () => {
    const r = toMcpResult(502, {})
    if (r.ok) throw new Error('expected failure')
    expect(r.error.message).toBe('http_502')
  })

  it('tolerates a null body', () => {
    const r = toMcpResult(500, null)
    expect(r.ok).toBe(false)
  })

  it('defaults conflict fields rather than throwing on a malformed 409', () => {
    const r = toMcpResult(409, {})
    if (r.ok) throw new Error('expected failure')
    if (r.error.kind !== 'conflict') throw new Error('expected conflict')
    expect(r.error.yourVersion).toBe(0)
    expect(r.error.conflictingFields).toEqual([])
  })
})

describe('errorText', () => {
  it('explains a conflict with both versions', () => {
    const text = errorText({
      kind: 'conflict',
      status: 409,
      message: 'x',
      yourVersion: 2,
      currentVersion: 5,
      conflictingFields: [],
      currentCard: {} as never,
    })
    expect(text).toContain('2')
    expect(text).toContain('5')
  })

  it('lists disallowed fields when present', () => {
    expect(
      errorText({
        kind: 'validation',
        status: 400,
        message: 'campo inválido',
        disallowedFields: ['title'],
        allowedFields: [],
      }),
    ).toContain('title')
  })

  it('surfaces the cause when offline', () => {
    expect(
      errorText({ kind: 'offline', message: 'x', cause: 'ECONNREFUSED' }),
    ).toContain('ECONNREFUSED')
  })
})
