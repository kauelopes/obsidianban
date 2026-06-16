import { describe, it, expect } from 'vitest'
import {
  HttpError,
  notFound,
  badRequest,
  conflict,
  forbidden,
} from '../../src/services/errors.js'

describe('HttpError', () => {
  it('stores status and body', () => {
    const err = new HttpError(400, { error: 'bad' })
    expect(err.status).toBe(400)
    expect(err.body).toEqual({ error: 'bad' })
  })

  it('uses error field as message', () => {
    const err = new HttpError(400, { error: 'bad_request' })
    expect(err.message).toBe('bad_request')
  })

  it('falls back to http_error message when error field is absent', () => {
    const err = new HttpError(500, { detail: 'oops' })
    expect(err.message).toBe('http_error')
  })

  it('is instanceof Error', () => {
    expect(new HttpError(400, { error: 'x' })).toBeInstanceOf(Error)
  })
})

describe('notFound', () => {
  it('returns 404 with error: not_found', () => {
    const err = notFound()
    expect(err.status).toBe(404)
    expect(err.body).toEqual({ error: 'not_found' })
  })
})

describe('badRequest', () => {
  it('returns 400 with the given error code', () => {
    const err = badRequest('invalid_field')
    expect(err.status).toBe(400)
    expect(err.body.error).toBe('invalid_field')
  })

  it('spreads extras into the body', () => {
    const err = badRequest('invalid_field', { field: 'title', max: 200 })
    expect(err.body).toMatchObject({ error: 'invalid_field', field: 'title', max: 200 })
  })

  it('works with no extras', () => {
    const err = badRequest('missing')
    expect(err.body).toEqual({ error: 'missing' })
  })
})

describe('conflict', () => {
  it('returns 409 with error: conflict', () => {
    const err = conflict({ reason: 'version_mismatch' })
    expect(err.status).toBe(409)
    expect(err.body.error).toBe('conflict')
  })

  it('spreads additional fields', () => {
    const err = conflict({ current_version: 5, your_version: 3 })
    expect(err.body).toMatchObject({ error: 'conflict', current_version: 5, your_version: 3 })
  })
})

describe('forbidden', () => {
  it('returns 403 with error: forbidden and reason', () => {
    const err = forbidden('not_assigned')
    expect(err.status).toBe(403)
    expect(err.body).toMatchObject({ error: 'forbidden', reason: 'not_assigned' })
  })

  it('spreads extras', () => {
    const err = forbidden('not_assigned', { assigned_to: 'agent:other' })
    expect(err.body).toMatchObject({ assigned_to: 'agent:other' })
  })
})
