import type { Priority } from '../types.js'
import { badRequest } from './errors.js'

const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high', 'critical']
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const NANOID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

export function requireString(
  p: Record<string, unknown>,
  key: string,
  max?: number,
  hint?: string,
): string {
  const v = p[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw badRequest('invalid_field', {
      field: key,
      expected: 'non-empty string',
      ...(hint ? { hint } : {}),
    })
  }
  if (max != null && v.length > max) {
    throw badRequest('invalid_field', {
      field: key,
      max_length: max,
      ...(hint ? { hint } : {}),
    })
  }
  return v
}

export function optString(p: Record<string, unknown>, key: string, max?: number): string | null {
  const v = p[key]
  if (v == null) return null
  if (typeof v !== 'string') {
    throw badRequest('invalid_field', { field: key, expected: 'string' })
  }
  if (max != null && v.length > max) {
    throw badRequest('invalid_field', { field: key, max })
  }
  return v
}

/** Distinguishes between "key absent" and "key present with null". */
export function optNullableString(
  p: Record<string, unknown>,
  key: string,
  max?: number,
): { present: boolean; value: string | null } {
  if (!(key in p)) return { present: false, value: null }
  const v = p[key]
  if (v === null) return { present: true, value: null }
  if (typeof v !== 'string') {
    throw badRequest('invalid_field', { field: key, expected: 'string or null' })
  }
  if (max != null && v.length > max) {
    throw badRequest('invalid_field', { field: key, max })
  }
  return { present: true, value: v }
}

export function requireInt(
  p: Record<string, unknown>,
  key: string,
  min = 0,
  hint?: string,
): number {
  const v = p[key]
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    throw badRequest('invalid_field', {
      field: key,
      expected: `integer >= ${min}`,
      ...(hint ? { hint } : {}),
    })
  }
  return v
}

export function optPriority(p: Record<string, unknown>): Priority | null {
  const v = p['priority']
  if (v == null) return null
  if (typeof v !== 'string' || !(PRIORITIES as readonly string[]).includes(v)) {
    throw badRequest('invalid_field', { field: 'priority', allowed: PRIORITIES })
  }
  return v as Priority
}

export function optTags(p: Record<string, unknown>): string[] | null {
  const v = p['tags']
  if (v == null) return null
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw badRequest('invalid_field', { field: 'tags', expected: 'string[]' })
  }
  if (v.length > 20) throw badRequest('invalid_field', { field: 'tags', max_items: 20 })
  if (v.some((t) => t.length > 50)) {
    throw badRequest('invalid_field', { field: 'tags', max_chars_each: 50 })
  }
  return v as string[]
}

export function optDueDate(p: Record<string, unknown>): { present: boolean; value: string | null } {
  if (!('due_date' in p)) return { present: false, value: null }
  const v = p['due_date']
  if (v === null) return { present: true, value: null }
  if (typeof v !== 'string' || !ISO_DATE.test(v)) {
    throw badRequest('invalid_field', { field: 'due_date', expected: 'YYYY-MM-DD or null' })
  }
  return { present: true, value: v }
}

/** Rejects any payload key not present in the allow-list. */
export function rejectDisallowed(
  p: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowSet = new Set(allowed)
  const disallowed = Object.keys(p).filter((k) => !allowSet.has(k))
  if (disallowed.length > 0) {
    throw badRequest('invalid_fields', {
      message: 'one or more payload fields are not allowed for this operation',
      disallowed_fields: disallowed,
      allowed_fields: [...allowed],
    })
  }
}

export function generateCardId(): string {
  return generateId('card')
}

export function generateSprintId(): string {
  return generateId('sprint')
}

function generateId(prefix: string): string {
  let id = `${prefix}-`
  const arr = new Uint8Array(8)
  crypto.getRandomValues(arr)
  for (const b of arr) id += NANOID_ALPHABET[b % NANOID_ALPHABET.length]
  return id
}
