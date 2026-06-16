// Exercises SSESubscriber against a live MCP server, then mutates state via
// McpClient and asserts the matching SSE frames arrive.
import { SSESubscriber, type SSEFrame } from '../plugin/src/mcp/sse-subscriber.js'
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
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(
  pred: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = pred()
    if (v) return v
    await sleep(20)
  }
  throw new Error(`timeout waiting for: ${label}`)
}

async function main(): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`
  const client = new McpClient({ baseUrl, token: token! })

  const frames: SSEFrame[] = []
  const statuses: string[] = []
  const sub = new SSESubscriber({
    baseUrl,
    onEvent: (f) => frames.push(f),
    onStatusChange: (s) => statuses.push(s),
    backoffStartMs: 50,
    backoffMaxMs: 200,
  })

  sub.start()
  await sleep(150) // small grace for headers
  expect(statuses.includes('connecting'), `connecting emitted: ${statuses.join(',')}`)
  expect(statuses.includes('connected'), `connected emitted: ${statuses.join(',')}`)
  pass('subscriber status: connecting → connected')

  // Trigger CARD_CREATED
  const created = await client.createCard({
    title: 'sse-1', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
  })
  expect(created.ok, 'create ok')
  if (!created.ok) return
  const cardId = created.data.id
  const createdFrame = await waitFor(
    () => frames.find((f) => f.type === 'CARD_CREATED' && (f.data as { card_id: string }).card_id === cardId),
    2000,
    'CARD_CREATED',
  )
  expect(createdFrame.id > 0, 'CARD_CREATED has positive id')
  pass('CARD_CREATED received')

  // Trigger CARD_UPDATED
  const updated = await client.updateCard({
    id: cardId, version: 1, title: 'sse-1-upd', input_tokens: 1, output_tokens: 1, model: 'm',
  })
  expect(updated.ok, 'update ok')
  const updatedFrame = await waitFor(
    () => frames.find((f) => f.type === 'CARD_UPDATED' && (f.data as { card_id: string }).card_id === cardId),
    2000,
    'CARD_UPDATED',
  )
  expect(updatedFrame.id > createdFrame.id, 'event ids monotonic')
  pass('CARD_UPDATED received')

  // Trigger CARD_MOVED
  const moved = await client.moveCard({
    id: cardId, version: 2, to_status: 'todo', input_tokens: 1, output_tokens: 1, model: 'm',
  })
  expect(moved.ok, 'move ok')
  const movedFrame = await waitFor(
    () => frames.find((f) => f.type === 'CARD_MOVED' && (f.data as { card_id: string }).card_id === cardId),
    2000,
    'CARD_MOVED',
  )
  const movedPayload = movedFrame.data as { to_status: string; from_status: string; new_position: number }
  expect(movedPayload.to_status === 'todo', `to_status=todo (got ${movedPayload.to_status})`)
  expect(movedPayload.from_status === 'backlog', `from_status=backlog`)
  expect(typeof movedPayload.new_position === 'number', 'new_position is number')
  pass('CARD_MOVED carries from_status, to_status, new_position')

  // Trigger CARD_REORDERED (need 2+ cards in same column)
  const c2 = await client.createCard({
    title: 'sse-2', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
  })
  expect(c2.ok, 'c2 ok')
  if (!c2.ok) return
  const c3 = await client.createCard({
    title: 'sse-3', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
  })
  expect(c3.ok, 'c3 ok')
  if (!c3.ok) return
  // wait for those CREATED frames
  await waitFor(() => frames.find((f) => f.type === 'CARD_CREATED' && (f.data as { card_id: string }).card_id === c3.data.id), 2000, 'CARD_CREATED for c3')

  const reorder = await client.reorderCard({
    id: c3.data.id, version: 1, after_card_id: null,
    input_tokens: 1, output_tokens: 1, model: 'm',
  })
  expect(reorder.ok, 'reorder ok')
  const reorderFrame = await waitFor(
    () => frames.find((f) => f.type === 'CARD_REORDERED'),
    2000,
    'CARD_REORDERED',
  )
  const reorderPayload = reorderFrame.data as { affected_cards: Array<{ id: string; new_position: number }> }
  expect(Array.isArray(reorderPayload.affected_cards), 'affected_cards is array')
  expect(reorderPayload.affected_cards.some((a) => a.id === c3.data.id), 'c3 in affected_cards')
  pass('CARD_REORDERED carries affected_cards array')

  // Reconnect behavior: stop & restart
  sub.stop()
  await sleep(50)
  const beforeReconnect = frames.length
  statuses.length = 0
  // Create the subscriber fresh — simulates user-triggered restart (saveSettings)
  const sub2 = new SSESubscriber({
    baseUrl,
    onEvent: (f) => frames.push(f),
    onStatusChange: (s) => statuses.push(s),
    backoffStartMs: 50,
    backoffMaxMs: 200,
  })
  sub2.start()
  await sleep(150)
  expect(statuses.includes('connected'), 'reconnected')
  const after = await client.createCard({
    title: 'sse-after', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
  })
  expect(after.ok, 'create after restart ok')
  if (!after.ok) return
  await waitFor(
    () => frames.find((f) => f.type === 'CARD_CREATED' && (f.data as { card_id: string }).card_id === after.data.id),
    2000,
    'CARD_CREATED after restart',
  )
  expect(frames.length > beforeReconnect, 'new frames received after restart')
  pass('subscriber can restart and receive subsequent events')

  // Trigger CARD_DELETED (new in batch 5: kanban_delete_card tool).
  // cardId went through create (v1) → update (v2) → move (v3); reorder only
  // touched c2/c3 in another column, so cardId is at v3.
  const del = await client.deleteCard({
    id: cardId, version: 3, input_tokens: 0, output_tokens: 0, model: 'm',
  })
  expect(del.ok, `delete ok: ${JSON.stringify(del)}`)
  if (!del.ok) return
  await waitFor(
    () => frames.find((f) => f.type === 'CARD_DELETED' && (f.data as { card_id: string }).card_id === cardId),
    2000,
    'CARD_DELETED',
  )
  pass('CARD_DELETED received')

  // Verify the card actually disappeared
  const gone = await client.getCard(cardId)
  expect(!gone.ok, 'deleted card returns error on get')
  pass('deleted card unreachable via getCard')

  sub2.stop()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
