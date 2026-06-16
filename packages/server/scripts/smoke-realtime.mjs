#!/usr/bin/env node
// SSE realtime smoke for the sprint+deps release. Asserts the wire-level
// promises the plugin's SSESubscriber depends on: every sprint and
// dependency mutation broadcasts the right event in the right order
// within a tight window, and Last-Event-ID resume replays events the
// subscriber missed while disconnected.

import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'

const VAULT = '/tmp/kanban-smoke-realtime'
const PORT = 13966
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'rtproj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, evidence = '') {
  const mark = cond ? '✓' : '✗'
  console.log(`  ${mark} ${name}${evidence ? ` [${evidence}]` : ''}`)
  if (!cond) failures += 1
}

function startMcp() {
  const c = spawn('node_modules/.bin/tsx', ['src/index.ts'], {
    env: { ...process.env, VAULT_PATH: VAULT, MCP_HTTP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  c.stderr.on('data', (d) => process.stderr.write(`[mcp-err] ${d}`))
  return c
}
async function stopMcp(child) {
  if (child.exitCode != null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(2000).then(() => { try { child.kill('SIGKILL') } catch {} })])
}
async function waitReady(child) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('startup timeout')), 8000)
    const onData = (d) => {
      if (d.toString().includes(' ready')) {
        clearTimeout(t)
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
  })
}
function runCli(args) {
  return new Promise((resolve) => {
    const c = spawn('node_modules/.bin/tsx', ['src/auth/cli.ts', ...args], {
      env: { ...process.env, VAULT_PATH: VAULT }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    c.stdout.on('data', (d) => (stdout += d.toString()))
    c.on('exit', () => resolve(stdout))
  })
}
function extractRawToken(stdout) {
  return /token:\s+(\S+)/.exec(stdout)[1]
}
async function call(tool, body, token) {
  const res = await fetch(`${BASE}/mcp/tool/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, body: json }
}

/**
 * Opens an SSE stream and collects every frame into an array. Returns a
 * handle with `events`, `lastId` (id of the most recent frame seen),
 * `close()`, and a `waitFor(predicate, timeoutMs)` helper that resolves
 * once an event matching the predicate arrives or rejects on timeout.
 */
function openSseStream(lastEventId) {
  const events = []
  let lastId = lastEventId ?? null
  const url = new URL('/events', BASE)
  const headers = { accept: 'text/event-stream' }
  if (lastEventId != null) headers['last-event-id'] = lastEventId
  const req = http.request({
    method: 'GET', hostname: url.hostname, port: url.port, path: url.pathname, headers,
  }, (res) => {
    let buf = ''
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const lines = frame.split('\n')
        const eventLine = lines.find((l) => l.startsWith('event:'))
        const idLine = lines.find((l) => l.startsWith('id:'))
        const dataLine = lines.find((l) => l.startsWith('data:'))
        if (!eventLine || !dataLine) continue
        const type = eventLine.slice(6).trim()
        const id = idLine ? idLine.slice(3).trim() : null
        try {
          const payload = JSON.parse(dataLine.slice(5).trim())
          events.push({ type, id, payload, ts: Date.now() })
          if (id != null) lastId = id
        } catch {}
      }
    })
  })
  req.on('error', () => {})
  req.end()
  const handle = {
    events,
    get lastId() { return lastId },
    close: () => req.destroy(),
    waitFor: (predicate, timeoutMs) => new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        const match = events.find((e) => predicate(e))
        if (match) return resolve(match)
        if (Date.now() > deadline) return reject(new Error('timeout'))
        setTimeout(tick, 25)
      }
      tick()
    }),
  }
  return handle
}

const TOK = { input_tokens: 0, output_tokens: 0, model: 'rt-smoke' }

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const mgr = extractRawToken(await runCli([
    'create', '--role', 'manager', '--actor', 'admin:me',
  ]))
  const agt = extractRawToken(await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:alice',
  ]))

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Realtime (SSE) smoke ===')

    // ── 1. Open stream, mutate, expect SPRINT_CREATED ─────────────
    const s1 = openSseStream(null)
    // Give the listener a tick to attach before the first mutation.
    await sleep(80)

    const cs = await call('kanban_create_sprint',
      { project: PROJECT, name: 'rt-sprint', goal: 'check the wire' }, mgr)
    const sprintId = cs.body.id

    const sprintCreatedFrame = await s1.waitFor(
      (e) => e.type === 'SPRINT_CREATED' && e.payload?.sprint_id === sprintId,
      1500,
    ).catch(() => null)
    check('SPRINT_CREATED arrives on the stream',
      sprintCreatedFrame != null,
      `frame=${sprintCreatedFrame?.type}`)
    check('SPRINT_CREATED payload carries project',
      sprintCreatedFrame?.payload?.project === PROJECT,
      `project=${sprintCreatedFrame?.payload?.project}`)

    // ── 2. add_to_sprint with move_to_todo flips status → CARD_UPDATED + SPRINT_UPDATED
    const c1 = await call('kanban_create_card',
      { title: 'rt-card', type: 'task', sprint_id: sprintId, ...TOK }, agt)

    const beforeAdd = s1.events.length
    await call('kanban_add_to_sprint',
      { sprint_id: sprintId, card_ids: [c1.body.id], move_to_todo: true }, mgr)

    const sprintUpdated = await s1.waitFor(
      (e, idx) => e.type === 'SPRINT_UPDATED' && e.payload?.sprint_id === sprintId,
      1500,
    ).catch(() => null)
    check('SPRINT_UPDATED arrives after add_to_sprint',
      sprintUpdated != null, `frame=${sprintUpdated?.type}`)

    const cardUpdated = s1.events
      .slice(beforeAdd)
      .find((e) => e.type === 'CARD_UPDATED' && e.payload?.card_id === c1.body.id)
    check('CARD_UPDATED also emitted for the added card',
      cardUpdated != null, `frame=${cardUpdated?.type}`)
    check('CARD_UPDATED.changed_fields mentions sprint_id',
      Array.isArray(cardUpdated?.payload?.changed_fields)
        && cardUpdated.payload.changed_fields.includes('sprint_id'),
      `changed=${JSON.stringify(cardUpdated?.payload?.changed_fields)}`)

    // ── 3. update_card setting blocked_by emits CARD_UPDATED with right field
    const c2 = await call('kanban_create_card',
      { title: 'rt-blocker', type: 'task', sprint_id: sprintId, ...TOK }, agt)
    const beforeBlock = s1.events.length
    await call('kanban_update_card',
      { id: c1.body.id, version: 2, blocked_by: [c2.body.id], ...TOK }, agt)
    const blockedUpdate = await s1.waitFor(
      (e) => e.ts > 0
        && e.type === 'CARD_UPDATED'
        && e.payload?.card_id === c1.body.id
        && Array.isArray(e.payload.changed_fields)
        && e.payload.changed_fields.includes('blocked_by')
        && e.ts > Date.now() - 2000,
      1500,
    ).catch(() => null)
    // Fallback: scan the new slice since waitFor scans from the beginning.
    const newish = s1.events.slice(beforeBlock).find(
      (e) => e.type === 'CARD_UPDATED'
        && e.payload?.card_id === c1.body.id
        && Array.isArray(e.payload.changed_fields)
        && e.payload.changed_fields.includes('blocked_by'),
    )
    check('CARD_UPDATED with blocked_by changed_field broadcasts',
      newish != null,
      `changed=${JSON.stringify(newish?.payload?.changed_fields)}`)

    // ── 4. Mutation rejected by guard does NOT emit ──────────────
    const beforeBlockMove = s1.events.length
    const blocked = await call('kanban_move_card',
      { id: c1.body.id, version: 3, to_status: 'in-progress', ...TOK }, agt)
    check('blocked move rejected by server → 409',
      blocked.status === 409, `status=${blocked.status}`)
    await sleep(300)
    const newSinceBlocked = s1.events.slice(beforeBlockMove)
    check('no SSE frames for the rejected mutation',
      newSinceBlocked.every((e) => e.payload?.card_id !== c1.body.id
        || e.type === 'SPRINT_UPDATED'),
      `n=${newSinceBlocked.length}`)

    // ── 5. Disconnect, mutate, reconnect with Last-Event-ID → replay ──
    const lastSeenId = s1.lastId
    check('stream tracked a non-null Last-Event-ID',
      lastSeenId != null, `last=${lastSeenId}`)
    s1.close()
    await sleep(150)

    // close_sprint now requires a planning sprint as rollover target — the
    // "no orphan cards" rule means we cannot strip sprint_id back to null.
    const rollover = await call('kanban_create_sprint',
      { project: PROJECT, name: 'rt-rollover', goal: 'catch leftovers' }, mgr)
    await call('kanban_close_sprint',
      { sprint_id: sprintId, rollover_to: rollover.body.id }, mgr)

    const s2 = openSseStream(lastSeenId)
    const replayed = await s2.waitFor(
      (e) => e.type === 'SPRINT_CLOSED' && e.payload?.sprint_id === sprintId,
      2000,
    ).catch(() => null)
    check('reconnect with Last-Event-ID replays the missed SPRINT_CLOSED',
      replayed != null, `frame=${replayed?.type}`)
    check('replayed event id > last seen id (chronologically newer)',
      replayed && parseInt(replayed.id, 10) > parseInt(lastSeenId, 10),
      `replay=${replayed?.id} > last=${lastSeenId}`)
    s2.close()

  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} realtime check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Realtime smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
