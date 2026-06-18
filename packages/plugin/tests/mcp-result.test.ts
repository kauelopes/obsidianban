import { describe, it, expect } from 'vitest'
import { toMcpResult } from '../src/mcp/client'

describe('toMcpResult', () => {
  it('retorna ok:true com data para status 200', () => {
    expect(toMcpResult<{ id: string }>(200, { id: 'abc' })).toEqual({
      ok: true,
      data: { id: 'abc' },
    })
  })

  it('retorna ConflictError completo para status 409', () => {
    const body = {
      message: 'version conflict',
      your_version: 1,
      current_version: 3,
      conflicting_fields: ['status', 'priority'],
      current_card: { id: 'c1', version: 3 },
    }
    const result = toMcpResult(409, body)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('conflict')
      if (result.error.kind === 'conflict') {
        expect(result.error.status).toBe(409)
        expect(result.error.yourVersion).toBe(1)
        expect(result.error.currentVersion).toBe(3)
        expect(result.error.conflictingFields).toEqual(['status', 'priority'])
        expect(result.error.message).toBe('version conflict')
      }
    }
  })

  it('usa defaults para campos ausentes no 409', () => {
    const result = toMcpResult(409, {})
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'conflict') {
      expect(result.error.yourVersion).toBe(0)
      expect(result.error.currentVersion).toBe(0)
      expect(result.error.conflictingFields).toEqual([])
      expect(result.error.message).toBe('conflict')
    }
  })

  it('retorna ValidationError completo para status 400', () => {
    const body = {
      message: 'invalid field',
      disallowed_fields: ['body'],
      allowed_fields: ['title', 'status'],
    }
    const result = toMcpResult(400, body)
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.status).toBe(400)
      expect(result.error.message).toBe('invalid field')
      expect(result.error.disallowedFields).toEqual(['body'])
      expect(result.error.allowedFields).toEqual(['title', 'status'])
    }
  })

  it('usa defaults para campos ausentes no 400', () => {
    const result = toMcpResult(400, {})
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.message).toBe('invalid_request')
      expect(result.error.disallowedFields).toEqual([])
      expect(result.error.allowedFields).toEqual([])
    }
  })

  it('retorna ServerError para status 500', () => {
    const result = toMcpResult(500, { message: 'internal error' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('server')
      if (result.error.kind === 'server') {
        expect(result.error.status).toBe(500)
        expect(result.error.message).toBe('internal error')
      }
    }
  })

  it('usa campo error como fallback de message no ServerError', () => {
    const result = toMcpResult(503, { error: 'service unavailable' })
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'server') {
      expect(result.error.message).toBe('service unavailable')
    }
  })

  it('usa http_<status> como fallback final de message', () => {
    const result = toMcpResult(503, {})
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'server') {
      expect(result.error.message).toBe('http_503')
    }
  })

  it('lida com body null em erros de servidor', () => {
    const result = toMcpResult(500, null)
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'server') {
      expect(result.error.message).toBe('http_500')
    }
  })

  it('inclui raw body no ServerError', () => {
    const body = { code: 'EPERM', details: 'locked' }
    const result = toMcpResult(500, body)
    expect(result.ok).toBe(false)
    if (!result.ok && result.error.kind === 'server') {
      expect(result.error.raw).toEqual(body)
    }
  })
})
