// Runner exercised by smoke-batch8.mjs via tsx. Each test emits a single
// line: `PASS|<msg>` or throws (smoke harness fails on non-zero exit).
import { McpClient } from '../plugin/src/mcp/client.js'

const token = process.env['MCP_TOKEN']
const port = process.env['MCP_PORT']
if (!token || !port) {
  console.error('runner: MCP_TOKEN and MCP_PORT required')
  process.exit(2)
}

function pass(msg: string): void {
  console.log(`PASS|${msg}`)
}
function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

async function main(): Promise<void> {
  const client = new McpClient({ baseUrl: `http://127.0.0.1:${port}`, token })

  // health (no auth required)
  const h = await client.health()
  expect(h.ok, `health ok: ${JSON.stringify(h)}`)
  if (!h.ok) return
  expect(h.data.status === 'ok', 'health.status === ok')
  pass('health() returns ok')

  // listCards on empty board
  const l0 = await client.listCards()
  expect(l0.ok, 'listCards initial ok')
  if (!l0.ok) return
  expect(Array.isArray(l0.data.cards) && l0.data.cards.length === 0, 'empty cards array')
  pass('listCards() empty')

  // createCard
  const c = await client.createCard({
    title: 'first', type: 'task', input_tokens: 3, output_tokens: 7, model: 'm1',
  })
  expect(c.ok, `createCard ok: ${JSON.stringify(c)}`)
  if (!c.ok) return
  expect(typeof c.data.id === 'string' && c.data.id.startsWith('card-'), 'created card has id')
  expect(c.data.version === 1, 'version=1')
  expect(c.data.status === 'backlog', 'status=backlog (default)')
  pass('createCard() returns Card')

  // getCard with body field
  const g = await client.getCard(c.data.id)
  expect(g.ok, 'getCard ok')
  if (!g.ok) return
  expect(g.data.id === c.data.id, 'getCard returns same id')
  expect(typeof g.data.body === 'string', 'getCard includes body field')
  pass('getCard() returns Card with body')

  // updateCard
  const u = await client.updateCard({
    id: c.data.id, version: 1, title: 'first-updated',
    input_tokens: 1, output_tokens: 2, model: 'm1',
  })
  expect(u.ok, 'updateCard ok')
  if (!u.ok) return
  expect(u.data.version === 2, 'version incremented to 2')
  expect(u.data.title === 'first-updated', 'title updated')
  pass('updateCard() bumps version')

  // moveCard
  const mv = await client.moveCard({
    id: c.data.id, version: 2, to_status: 'in-progress',
    input_tokens: 1, output_tokens: 1, model: 'm1',
  })
  expect(mv.ok, 'moveCard ok')
  if (!mv.ok) return
  expect(mv.data.status === 'in-progress', 'status updated')
  pass('moveCard() changes status')

  // reorderCard
  const c2 = await client.createCard({
    title: 'second', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm1',
  })
  expect(c2.ok, 'c2 created')
  if (!c2.ok) return
  const c3 = await client.createCard({
    title: 'third', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm1',
  })
  expect(c3.ok, 'c3 created')
  if (!c3.ok) return
  const r = await client.reorderCard({
    id: c3.data.id, version: 1, after_card_id: null,
    input_tokens: 1, output_tokens: 1, model: 'm1',
  })
  expect(r.ok, 'reorderCard ok')
  if (!r.ok) return
  expect(r.data.card.id === c3.data.id, 'reorder returns target card')
  expect(Array.isArray(r.data.affected_cards), 'reorder returns affected_cards array')
  pass('reorderCard() returns ReorderResult')

  // 409 ConflictError
  const stale = await client.updateCard({
    id: c.data.id, version: 99, title: 'wont',
    input_tokens: 1, output_tokens: 1, model: 'm1',
  })
  expect(!stale.ok, '409 returned as error')
  if (stale.ok) return
  expect(stale.error.kind === 'conflict', `kind=conflict (got ${stale.error.kind})`)
  if (stale.error.kind !== 'conflict') return
  expect(stale.error.yourVersion === 99, 'yourVersion=99')
  expect(stale.error.currentVersion >= 2, 'currentVersion >= 2')
  expect(Array.isArray(stale.error.conflictingFields), 'conflictingFields is array')
  expect(stale.error.currentCard != null, 'currentCard present')
  pass('ConflictError discriminated correctly')

  // 400 ValidationError — disallowed field
  const bad = await client.createCard({
    title: 'x', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm1',
    // @ts-expect-error: deliberate disallowed field
    id: 'card-cantsetthis',
  })
  expect(!bad.ok, 'disallowed field rejected')
  if (bad.ok) return
  expect(bad.error.kind === 'validation', `kind=validation (got ${bad.error.kind})`)
  if (bad.error.kind !== 'validation') return
  expect(bad.error.disallowedFields.includes('id'), 'disallowedFields includes id')
  pass('ValidationError discriminated correctly')

  // metrics endpoint via client (no auth required)
  const m = await client.getMetrics()
  expect(m.ok, 'metrics ok')
  if (!m.ok) return
  expect(typeof m.data.summary.total_input_tokens === 'number', 'metrics summary present')
  pass('getMetrics() returns Metrics')

  // OfflineError — point at bogus port
  const offline = new McpClient({ baseUrl: 'http://127.0.0.1:1', token, timeoutMs: 800 })
  const off = await offline.listCards()
  expect(!off.ok, 'offline returns error')
  if (off.ok) return
  expect(off.error.kind === 'offline', `kind=offline (got ${off.error.kind})`)
  pass('OfflineError on unreachable host')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
