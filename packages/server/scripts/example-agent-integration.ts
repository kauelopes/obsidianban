// End-to-end agent integration example for ObsidianKan MCP.
// Demonstrates: auth, request_id-driven idempotency, conflict handling,
// SSE subscription, the mandatory token-tracking fields, and the
// happy paths for create / update / move / delete.
//
// Run against a live MCP:
//
//   KANBAN_MCP_TOKEN=<agent-token> \
//   node --import tsx scripts/example-agent-integration.ts
//
// Optional env:
//   KANBAN_MCP_URL  (default http://127.0.0.1:9375)
//   KANBAN_MCP_MODEL (default 'example-agent-1.0')

import { randomUUID } from 'node:crypto'
import http from 'node:http'

const BASE = process.env.KANBAN_MCP_URL ?? 'http://127.0.0.1:9375'
const TOKEN = process.env.KANBAN_MCP_TOKEN
const MODEL = process.env.KANBAN_MCP_MODEL ?? 'example-agent-1.0'

if (!TOKEN) {
  console.error('error: KANBAN_MCP_TOKEN is required')
  process.exit(2)
}

interface Card {
  id: string
  project: string
  title: string
  status: string
  version: number
  position: number
  priority: string
  body?: string
}

interface ConflictResponse {
  error: 'conflict'
  message: string
  your_version: number
  current_version: number
  conflicting_fields: string[]
  current_card: Card
}

// ── HTTP helper ────────────────────────────────────────────────
async function call<T>(tool: string, payload: Record<string, unknown>): Promise<{
  status: number
  body: T | ConflictResponse | { error: string }
}> {
  const res = await fetch(`${BASE}/mcp/tool/${tool}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = { error: 'invalid_json', raw: text }
  }
  return { status: res.status, body: body as T }
}

// Mutating tools require these three fields on EVERY call. Bundle them
// once so we don't lose track.
function tokens(input: number, output: number): {
  input_tokens: number
  output_tokens: number
  model: string
} {
  return { input_tokens: input, output_tokens: output, model: MODEL }
}

// ── 1. Health probe ────────────────────────────────────────────
async function checkHealth(): Promise<void> {
  const res = await fetch(`${BASE}/health`)
  if (!res.ok) throw new Error(`MCP unreachable: HTTP ${res.status}`)
  console.log('[1] health: ok')
}

// ── 2. Create with idempotent retry ────────────────────────────
async function createCard(): Promise<Card> {
  const requestId = randomUUID()
  const payload = {
    title: 'integration example',
    type: 'task',
    status: 'backlog',
    priority: 'medium',
    request_id: requestId,
    ...tokens(120, 8),
  }
  const first = await call<Card>('kanban_create_card', payload)
  if (first.status !== 200) throw new Error(`create failed: ${JSON.stringify(first.body)}`)
  const created = first.body as Card
  console.log(`[2] created card ${created.id} (version=${created.version})`)

  // Retry with the same request_id → cached response (same id, same version).
  // No token accumulation happens server-side.
  const retry = await call<Card>('kanban_create_card', payload)
  const same = (retry.body as Card).id === created.id
  console.log(`[2.1] idempotent retry replay: same id = ${same}`)
  return created
}

// ── 3. Update with conflict handling ───────────────────────────
async function updateWithConflict(card: Card): Promise<Card> {
  // First successful update establishes a new version on the server.
  const real = await call<Card>('kanban_update_card', {
    id: card.id,
    version: card.version,
    priority: 'high',
    request_id: randomUUID(),
    ...tokens(45, 12),
  })
  if (real.status !== 200) throw new Error(`update failed: ${JSON.stringify(real.body)}`)
  const updated = real.body as Card

  // Now simulate a stale agent racing on the old version → 409.
  const stale = await call<Card | ConflictResponse>('kanban_update_card', {
    id: card.id,
    version: card.version,  // ← stale, server is now at updated.version
    title: 'stale rename attempt',
    request_id: randomUUID(),
    ...tokens(8, 2),
  })
  if (stale.status !== 409) {
    throw new Error(`expected 409 on stale write, got ${stale.status}`)
  }
  const conflict = stale.body as ConflictResponse
  console.log(
    `[3] conflict on stale update: your=v${conflict.your_version} ` +
    `current=v${conflict.current_version} conflicting=${JSON.stringify(conflict.conflicting_fields)}`,
  )

  // Resolution: our intent (rename to 'stale rename attempt') still applies
  // on top of current_card. Retry with the server's current version + a
  // brand-new request_id (the previous one is invalidated by the 409).
  const resolved = await call<Card>('kanban_update_card', {
    id: card.id,
    version: conflict.current_card.version,
    title: 'resolved rename',
    request_id: randomUUID(),
    ...tokens(8, 2),
  })
  if (resolved.status !== 200) throw new Error(`retry after conflict failed: ${JSON.stringify(resolved.body)}`)
  const final = resolved.body as Card
  console.log(`[3.1] retry resolved at version ${final.version}, title="${final.title}"`)
  return final
}

// ── 4. Move across columns ─────────────────────────────────────
async function moveCard(card: Card): Promise<Card> {
  const res = await call<Card>('kanban_move_card', {
    id: card.id,
    version: card.version,
    to_status: 'todo',
    request_id: randomUUID(),
    ...tokens(3, 1),
  })
  if (res.status !== 200) throw new Error(`move failed: ${JSON.stringify(res.body)}`)
  const moved = res.body as Card
  console.log(`[4] moved card to ${moved.status} (version=${moved.version})`)
  return moved
}

// ── 5. SSE subscription (~2s window, then close) ───────────────
interface SseHandle {
  ready: Promise<void>
  caught: Promise<void>
  close: () => void
}

function openSse(targetCardId: string, timeoutMs: number): SseHandle {
  const url = new URL('/events', BASE)
  let resolveReady!: () => void
  let resolveCaught!: () => void
  const ready = new Promise<void>((r) => { resolveReady = r })
  const caught = new Promise<void>((r) => { resolveCaught = r })
  const req = http.request({
    method: 'GET',
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    headers: { accept: 'text/event-stream' },
  }, (res) => {
    resolveReady()
    let buf = ''
    const timer = setTimeout(() => {
      console.log('[5] SSE: window elapsed, closing')
      req.destroy()
      resolveCaught()
    }, timeoutMs)
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        // SSE frame: each non-empty line is "<field>: <value>". The server
        // sends `event: <TYPE>` and `data: <JSON payload>` (no envelope —
        // `data` is the raw payload, the type lives in the event header).
        const lines = frame.split('\n')
        const eventLine = lines.find((l) => l.startsWith('event:'))
        const dataLine = lines.find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        try {
          const payload = JSON.parse(dataLine.slice(5).trim())
          if (payload?.card_id === targetCardId) {
            const type = eventLine ? eventLine.slice(6).trim() : 'unknown'
            console.log(`[5] SSE: ${type} for ${targetCardId}`)
            clearTimeout(timer)
            req.destroy()
            resolveCaught()
            return
          }
        } catch { /* ignore non-JSON keepalives */ }
      }
    })
    res.on('end', () => { clearTimeout(timer); resolveCaught() })
  })
  req.on('error', () => { resolveReady(); resolveCaught() })
  req.end()
  return { ready, caught, close: () => req.destroy() }
}

// ── 6. Delete ──────────────────────────────────────────────────
async function deleteCard(card: Card): Promise<void> {
  const res = await call<{ deleted: true; id: string; version: number }>('kanban_delete_card', {
    id: card.id,
    version: card.version,
    request_id: randomUUID(),
    ...tokens(2, 1),
  })
  if (res.status !== 200) throw new Error(`delete failed: ${JSON.stringify(res.body)}`)
  console.log(`[6] deleted card ${card.id}`)
}

// ── Driver ─────────────────────────────────────────────────────
async function main(): Promise<void> {
  await checkHealth()
  const created = await createCard()
  const updated = await updateWithConflict(created)
  const moved = await moveCard(updated)
  // Subscribe to SSE and wait until the connection is established before
  // firing a mutation — otherwise the event may be emitted before our
  // handler is attached and we miss it.
  const sse = openSse(moved.id, 3000)
  await sse.ready
  await call('kanban_update_card', {
    id: moved.id,
    version: moved.version,
    priority: 'critical',
    request_id: randomUUID(),
    ...tokens(4, 2),
  })
  await sse.caught
  const refreshed = await call<Card>('kanban_get_card', { id: moved.id })
  await deleteCard(refreshed.body as Card)
  console.log('\n✓ integration example complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
