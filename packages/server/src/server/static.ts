import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import { logger } from '../util/logger.js'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

export class StaticSite {
  /** Absolute, resolved once so every request compares against the same prefix. */
  private readonly root: string

  constructor(root: string) {
    this.root = path.resolve(root)
  }

  async isAvailable(): Promise<boolean> {
    try {
      await fs.access(path.join(this.root, 'index.html'))
      return true
    } catch {
      logger.warn({ root: this.root }, 'static: no index.html — SPA not served (run pnpm --filter @obsidiankan/web build)')
      return false
    }
  }

  /**
   * Serves a built SPA. Unknown paths fall back to index.html so client-side
   * routes like /card/:id survive a page reload; anything under a known asset
   * extension 404s instead, so a missing bundle fails loudly rather than
   * returning HTML that the browser then refuses to execute.
   */
  async serve(urlPath: string, res: ServerResponse): Promise<void> {
    const clean = decodeURIComponent((urlPath.split('?')[0] ?? '/').split('#')[0] ?? '/')
    const candidate = path.resolve(this.root, '.' + path.posix.normalize(clean))

    // path.resolve collapses ../ — anything landing outside the root is an
    // escape attempt and never gets read.
    if (candidate !== this.root && !candidate.startsWith(this.root + path.sep)) {
      res.statusCode = 403
      res.end('forbidden')
      return
    }

    const direct = await readFileOrNull(candidate)
    if (direct) {
      send(res, candidate, direct)
      return
    }

    if (path.extname(candidate) !== '') {
      res.statusCode = 404
      res.end('not found')
      return
    }

    const index = path.join(this.root, 'index.html')
    const html = await readFileOrNull(index)
    if (!html) {
      res.statusCode = 404
      res.end('not found')
      return
    }
    send(res, index, html)
  }
}

async function readFileOrNull(p: string): Promise<Buffer | null> {
  try {
    const st = await fs.stat(p)
    if (!st.isFile()) return null
    return await fs.readFile(p)
  } catch {
    return null
  }
}

function send(res: ServerResponse, filePath: string, data: Buffer): void {
  res.statusCode = 200
  res.setHeader('content-type', MIME[path.extname(filePath)] ?? 'application/octet-stream')
  // Vite fingerprints asset filenames, so they are safe to cache hard; the
  // entry HTML must not be, or a rebuild would never reach the browser.
  res.setHeader(
    'cache-control',
    path.basename(filePath) === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  )
  res.end(data)
}
