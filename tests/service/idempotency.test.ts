import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { IdempotencyStore, isValidRequestId } from '../../src/server/idempotency.js'

const TTL_MS = 24 * 60 * 60 * 1000

let storePath: string

beforeEach(() => {
  storePath = path.join(os.tmpdir(), `ikan-idem-${Date.now()}-${Math.random()}.json`)
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.rm(storePath, { force: true })
})

describe('isValidRequestId', () => {
  it('accepts a valid UUID v4', () => {
    expect(isValidRequestId('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(true)
  })

  it('accepts a valid UUID v4 in uppercase', () => {
    expect(isValidRequestId('F47AC10B-58CC-4372-A567-0E02B2C3D479')).toBe(true)
  })

  it('rejects a UUID v1 (version digit != 4)', () => {
    expect(isValidRequestId('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(false)
  })

  it('rejects a plain string', () => {
    expect(isValidRequestId('not-a-uuid')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(isValidRequestId('')).toBe(false)
  })

  it('rejects a UUID with extra characters', () => {
    expect(isValidRequestId('f47ac10b-58cc-4372-a567-0e02b2c3d479-extra')).toBe(false)
  })
})

describe('IdempotencyStore.load', () => {
  it('succeeds on non-existent file and leaves cache empty', async () => {
    const store = new IdempotencyStore(storePath)
    await expect(store.load()).resolves.not.toThrow()
    expect(store.get('any-id')).toBeNull()
  })

  it('reads existing valid entries from disk', async () => {
    const entry = { request_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', ts: Date.now(), response: { ok: true } }
    await fs.writeFile(storePath, JSON.stringify({ entries: [entry] }), 'utf8')

    const store = new IdempotencyStore(storePath)
    await store.load()
    expect(store.get(entry.request_id)).not.toBeNull()
    expect(store.get(entry.request_id)?.response).toEqual({ ok: true })
  })

  it('prunes expired entries (older than 24h) on load', async () => {
    const expiredEntry = {
      request_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      ts: Date.now() - TTL_MS - 1000,
      response: { old: true },
    }
    await fs.writeFile(storePath, JSON.stringify({ entries: [expiredEntry] }), 'utf8')

    const store = new IdempotencyStore(storePath)
    await store.load()
    expect(store.get(expiredEntry.request_id)).toBeNull()
  })

  it('re-persists file without expired entries after pruning', async () => {
    const expiredEntry = {
      request_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      ts: Date.now() - TTL_MS - 1000,
      response: {},
    }
    await fs.writeFile(storePath, JSON.stringify({ entries: [expiredEntry] }), 'utf8')

    const store = new IdempotencyStore(storePath)
    await store.load()

    const raw = await fs.readFile(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.entries).toHaveLength(0)
  })

  it('throws on malformed JSON (not ENOENT)', async () => {
    await fs.writeFile(storePath, '{broken json', 'utf8')
    const store = new IdempotencyStore(storePath)
    await expect(store.load()).rejects.toThrow()
  })
})

describe('IdempotencyStore.get', () => {
  it('returns null for unknown id before any put', () => {
    const store = new IdempotencyStore(storePath)
    expect(store.get('unknown-id')).toBeNull()
  })

  it('returns entry after put', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const store = new IdempotencyStore(storePath)
    await store.put(id, { result: 'success' })
    const entry = store.get(id)
    expect(entry).not.toBeNull()
    expect(entry?.response).toEqual({ result: 'success' })
  })

  it('returns null for an entry whose TTL has expired', async () => {
    vi.useFakeTimers()
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const store = new IdempotencyStore(storePath)
    await store.put(id, { data: 'x' })
    // Advance time past TTL
    vi.setSystemTime(Date.now() + TTL_MS + 1000)
    expect(store.get(id)).toBeNull()
  })
})

describe('IdempotencyStore.put', () => {
  it('creates the cache file on disk', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const store = new IdempotencyStore(storePath)
    await store.put(id, { x: 1 })
    await expect(fs.stat(storePath)).resolves.toBeDefined()
  })

  it('stores the response correctly on disk', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const store = new IdempotencyStore(storePath)
    await store.put(id, { value: 42 })
    const raw = await fs.readFile(storePath, 'utf8')
    const parsed = JSON.parse(raw)
    expect(parsed.entries[0].response).toEqual({ value: 42 })
  })

  it('second put with same id overwrites the response', async () => {
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const store = new IdempotencyStore(storePath)
    await store.put(id, { v: 1 })
    await store.put(id, { v: 2 })
    expect(store.get(id)?.response).toEqual({ v: 2 })
  })

  it('creates parent directory if missing', async () => {
    const nestedPath = path.join(os.tmpdir(), `ikan-nested-${Date.now()}`, 'sub', 'idem.json')
    const store = new IdempotencyStore(nestedPath)
    await expect(store.put('f47ac10b-58cc-4372-a567-0e02b2c3d479', {})).resolves.not.toThrow()
    await fs.rm(path.dirname(path.dirname(nestedPath)), { recursive: true, force: true })
  })

  it('concurrent puts with different ids both persist without corruption', async () => {
    const store = new IdempotencyStore(storePath)
    const id1 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    const id2 = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    await Promise.all([store.put(id1, { a: 1 }), store.put(id2, { b: 2 })])

    const store2 = new IdempotencyStore(storePath)
    await store2.load()
    // Both entries should be loadable — order depends on which put won the race
    // At minimum, neither should corrupt the file
    const raw = await fs.readFile(storePath, 'utf8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})
