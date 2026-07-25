import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { StaticSite } from '../../src/server/static.js'

let root: string
let secretDir: string

/** Minimal stand-in for ServerResponse capturing what the handler wrote. */
function fakeRes() {
  const headers: Record<string, string> = {}
  return {
    statusCode: 0,
    body: null as string | null,
    setHeader(k: string, v: string) {
      headers[k.toLowerCase()] = v
    },
    header(k: string) {
      return headers[k.toLowerCase()]
    },
    end(data?: Buffer | string) {
      this.body = data == null ? '' : Buffer.isBuffer(data) ? data.toString('utf8') : data
    },
  }
}

type Res = ReturnType<typeof fakeRes>

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-static-'))
  root = path.join(base, 'dist')
  secretDir = base
  await fs.mkdir(path.join(root, 'assets'), { recursive: true })
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html>spa', 'utf8')
  await fs.writeFile(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)', 'utf8')
  await fs.writeFile(path.join(secretDir, 'secret.txt'), 'NAO DEVE VAZAR', 'utf8')
})

afterEach(async () => {
  await fs.rm(secretDir, { recursive: true, force: true })
})

describe('StaticSite.isAvailable', () => {
  it('is true when index.html exists', async () => {
    expect(await new StaticSite(root).isAvailable()).toBe(true)
  })

  it('is false when the build is absent', async () => {
    expect(await new StaticSite(path.join(secretDir, 'nope')).isAvailable()).toBe(false)
  })
})

describe('StaticSite.serve', () => {
  it('serves index.html at the root', async () => {
    const res = fakeRes()
    await new StaticSite(root).serve('/', res as unknown as Res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('spa')
    expect(res.header('content-type')).toContain('text/html')
  })

  it('serves a hashed asset with an immutable cache header', async () => {
    const res = fakeRes()
    await new StaticSite(root).serve('/assets/app-abc123.js', res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('console.log(1)')
    expect(res.header('cache-control')).toContain('immutable')
  })

  it('never lets index.html be cached', async () => {
    const res = fakeRes()
    await new StaticSite(root).serve('/', res as never)
    expect(res.header('cache-control')).toBe('no-cache')
  })

  it('falls back to index.html for a client-side route', async () => {
    const res = fakeRes()
    await new StaticSite(root).serve('/card/card-2vorDD5G', res as never)
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('spa')
  })

  it('404s a missing asset instead of returning HTML', async () => {
    const res = fakeRes()
    await new StaticSite(root).serve('/assets/gone-999.js', res as never)
    expect(res.statusCode).toBe(404)
    expect(res.body).not.toContain('spa')
  })

  it('ignores the query string when resolving', async () => {
    const res = fakeRes()
    await new StaticSite(root).serve('/assets/app-abc123.js?v=2', res as never)
    expect(res.statusCode).toBe(200)
  })
})

describe('StaticSite.serve — path traversal', () => {
  const attacks = [
    '/../secret.txt',
    '/../../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
  ]

  it('never reads a file outside the root', async () => {
    for (const attack of attacks) {
      const res = fakeRes()
      await new StaticSite(root).serve(attack, res as never)
      expect(res.body, `leaked via ${attack}`).not.toContain('NAO DEVE VAZAR')
      expect([403, 404, 200]).toContain(res.statusCode)
      // A 200 is only acceptable when it is the SPA fallback, never the secret.
      if (res.statusCode === 200) expect(res.body).toContain('spa')
    }
  })
})
