import { describe, it, expect } from 'vitest'
import {
  requireString,
  optString,
  optNullableString,
  optInt,
  requireInt,
  optPriority,
  optTags,
  optDueDate,
  rejectDisallowed,
  generateCardId,
} from '../../src/services/validation.js'
import { HttpError } from '../../src/services/errors.js'

function expectBadRequest(fn: () => unknown, expectedError?: string) {
  expect(fn).toThrow(HttpError)
  try { fn() } catch (e) {
    const err = e as HttpError
    expect(err.status).toBe(400)
    if (expectedError) expect(err.body.error).toBe(expectedError)
  }
}

describe('requireString', () => {
  it('returns string value', () => {
    expect(requireString({ name: 'hello' }, 'name')).toBe('hello')
  })

  it('throws 400 if field is absent', () => {
    expectBadRequest(() => requireString({}, 'name'), 'invalid_field')
  })

  it('throws 400 if field is empty string', () => {
    expectBadRequest(() => requireString({ name: '' }, 'name'))
  })

  it('throws 400 if field exceeds max', () => {
    expectBadRequest(() => requireString({ name: 'ab' }, 'name', 1))
  })

  it('accepts string exactly at max', () => {
    expect(requireString({ name: 'ab' }, 'name', 2)).toBe('ab')
  })

  it('throws 400 for non-string types', () => {
    expectBadRequest(() => requireString({ name: 42 }, 'name'))
  })
})

describe('optString', () => {
  it('returns null if key is absent', () => {
    expect(optString({}, 'x')).toBeNull()
  })

  it('returns the string', () => {
    expect(optString({ x: 'hi' }, 'x')).toBe('hi')
  })

  it('throws 400 if value exceeds max', () => {
    expectBadRequest(() => optString({ x: 'toolong' }, 'x', 3))
  })

  it('throws 400 for non-string type', () => {
    expectBadRequest(() => optString({ x: 123 }, 'x'))
  })
})

describe('optNullableString', () => {
  it('returns {present:false} when key is absent', () => {
    expect(optNullableString({}, 'x')).toEqual({ present: false, value: null })
  })

  it('returns {present:true, value:null} when key is null', () => {
    expect(optNullableString({ x: null }, 'x')).toEqual({ present: true, value: null })
  })

  it('returns {present:true, value:string} when key has string', () => {
    expect(optNullableString({ x: 'hi' }, 'x')).toEqual({ present: true, value: 'hi' })
  })

  it('throws 400 for non-string non-null values', () => {
    expectBadRequest(() => optNullableString({ x: 42 }, 'x'))
  })
})

describe('optInt', () => {
  it('returns default if key absent', () => {
    expect(optInt({}, 'n', 5)).toBe(5)
  })

  it('returns integer value', () => {
    expect(optInt({ n: 3 }, 'n', 0)).toBe(3)
  })

  it('throws 400 for float', () => {
    expectBadRequest(() => optInt({ n: 1.5 }, 'n', 0))
  })

  it('throws 400 for negative number', () => {
    expectBadRequest(() => optInt({ n: -1 }, 'n', 0))
  })

  it('throws 400 for string', () => {
    expectBadRequest(() => optInt({ n: '3' }, 'n', 0))
  })

  it('accepts zero', () => {
    expect(optInt({ n: 0 }, 'n', 99)).toBe(0)
  })
})

describe('requireInt', () => {
  it('returns the integer', () => {
    expect(requireInt({ n: 2 }, 'n')).toBe(2)
  })

  it('throws 400 if absent', () => {
    expectBadRequest(() => requireInt({}, 'n'))
  })

  it('throws 400 if below min', () => {
    expectBadRequest(() => requireInt({ n: 0 }, 'n', 1))
  })

  it('accepts value equal to min', () => {
    expect(requireInt({ n: 1 }, 'n', 1)).toBe(1)
  })
})

describe('optPriority', () => {
  it('returns null if absent', () => {
    expect(optPriority({})).toBeNull()
  })

  for (const p of ['low', 'medium', 'high', 'critical'] as const) {
    it(`accepts "${p}"`, () => {
      expect(optPriority({ priority: p })).toBe(p)
    })
  }

  it('throws 400 for invalid priority', () => {
    expectBadRequest(() => optPriority({ priority: 'extreme' }))
  })
})

describe('optTags', () => {
  it('returns null if absent', () => {
    expect(optTags({})).toBeNull()
  })

  it('returns array of strings', () => {
    expect(optTags({ tags: ['a', 'b'] })).toEqual(['a', 'b'])
  })

  it('throws 400 if more than 20 items', () => {
    const arr = Array.from({ length: 21 }, (_, i) => `tag${i}`)
    expectBadRequest(() => optTags({ tags: arr }))
  })

  it('throws 400 if any item exceeds 50 chars', () => {
    const longTag = 'a'.repeat(51)
    expectBadRequest(() => optTags({ tags: [longTag] }))
  })

  it('throws 400 if not an array', () => {
    expectBadRequest(() => optTags({ tags: 'not-array' }))
  })

  it('throws 400 if array contains non-strings', () => {
    expectBadRequest(() => optTags({ tags: [1, 2] }))
  })
})

describe('optDueDate', () => {
  it('returns {present:false} if key absent', () => {
    expect(optDueDate({})).toEqual({ present: false, value: null })
  })

  it('returns {present:true, value:null} for null', () => {
    expect(optDueDate({ due_date: null })).toEqual({ present: true, value: null })
  })

  it('accepts valid YYYY-MM-DD', () => {
    expect(optDueDate({ due_date: '2026-12-31' })).toEqual({ present: true, value: '2026-12-31' })
  })

  it('throws 400 for invalid format', () => {
    expectBadRequest(() => optDueDate({ due_date: '2026/12/31' }))
  })

  it('throws 400 for partial date', () => {
    expectBadRequest(() => optDueDate({ due_date: '2026-12' }))
  })
})

describe('rejectDisallowed', () => {
  it('passes when all keys are allowed', () => {
    expect(() => rejectDisallowed({ a: 1, b: 2 }, ['a', 'b', 'c'])).not.toThrow()
  })

  it('throws 400 with disallowed_fields list', () => {
    try {
      rejectDisallowed({ a: 1, x: 2, y: 3 }, ['a'])
      expect.fail('should throw')
    } catch (e) {
      const err = e as HttpError
      expect(err.status).toBe(400)
      expect((err.body.disallowed_fields as string[]).sort()).toEqual(['x', 'y'])
    }
  })
})

describe('generateCardId', () => {
  it('starts with "card-"', () => {
    expect(generateCardId()).toMatch(/^card-/)
  })

  it('has exactly 8 base62 chars after prefix', () => {
    const id = generateCardId()
    const suffix = id.replace('card-', '')
    expect(suffix).toHaveLength(8)
    expect(suffix).toMatch(/^[0-9A-Za-z]+$/)
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateCardId()))
    expect(ids.size).toBe(1000)
  })
})
