#!/usr/bin/env node
// Archive feature smoke. Covers the round trip for kanban_archive_card /
// kanban_unarchive_card: response shape, query-filter precedence,
// version bump + no-op short-circuit, optimistic locking, audit log,
// SSE broadcast.

import { rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-archive'
const PORT = 13966
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'archproj'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, cond, evidence = '') {
  const mark = cond ? '✓' : '✗'
  console.log(`  ${mark} ${name}${evidence ? ` [${evidence}]` : ''}`)
  if (!cond) failures += 1
}

function startMcp() {
  const child = spawn('node_modules/.bin/tsx', ['src/index.ts'], {
    env: { ...process.env, VAULT_PATH: VAULT, MCP_HTTP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stderr.write(`[mcp-err] ${d}`))
  return child
}
async function stopMcp(child) {
  if (child.exitCode != null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  await Promise.race([exited, sleep(2000).then(() => { try { child.kill('SIGKILL') } catch {} })])
}
async function waitReady(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('startup timeout')), timeoutMs)
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
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['src/auth/cli.ts', ...args], {
      env: { ...process.env, VAULT_PATH: VAULT },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('exit', (code) => resolve({ code, stdout, stderr }))
    child.on('error', reject)
  })
}
function extractRawToken(stdout) {
  const m = /token:\s+(\S+)/.exec(stdout)
  if (!m) throw new Error('could not parse token from CLI output')
  return m[1]
}
async function call(tool, body, headers) {
  const res = await fetch(`${BASE}/mcp/tool/${tool}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, body: json, raw: text }
}
async function readAudit() {
  const raw = await readFile(path.join(VAULT, '.kanban', 'audit.ndjson'), 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

// SSE: listen, collect frames for `windowMs`, return events seen for `cardId`.
function collectSse(cardId, windowMs) {
  return new Promise((resolve) => {
    const events = []
    const url = new URL('/events', BASE)
    const req = http.request({
      method: 'GET',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      headers: { accept: 'text/event-stream' },
    }, (res) => {
      let buf = ''
      const timer = setTimeout(() => { req.destroy(); resolve(events) }, windowMs)
      res.on('data', (chunk) => {
        buf += chunk.toString('utf8')
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const frame of frames) {
          const lines = frame.split('\n')
          const eventLine = lines.find((l) => l.startsWith('event:'))
          const dataLine = lines.find((l) => l.startsWith('data:'))
          if (!eventLine || !dataLine) continue
          try {
            const payload = JSON.parse(dataLine.slice(5).trim())
            if (payload?.card_id === cardId) {
              events.push({ type: eventLine.slice(6).trim(), payload })
            }
          } catch {}
        }
      })
      res.on('end', () => { clearTimeout(timer); resolve(events) })
    })
    req.on('error', () => resolve(events))
    req.end()
    // small delay so the listener attaches before the caller fires its mutation
    setTimeout(() => {}, 50)
  })
}

const TOK = { input_tokens: 0, output_tokens: 0, model: 'smoke' }

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const tok = extractRawToken((await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:archy',
  ])).stdout)
  const auth = { authorization: `Bearer ${tok}` }
  const mcp = startMcp()
  await waitReady(mcp)

  try {
    console.log('=== Archive feature smoke ===')

    // 1. Create a card to work with.
    const created = await call('kanban_create_card',
      { title: 'arch-target', type: 'task', ...TOK }, auth)
    check('create card → 200', created.status === 200, `status=${created.status}`)
    const id = created.body.id
    const v1 = created.body.version
    check('new card archived=false', created.body.archived === false, `archived=${created.body.archived}`)

    // 2. Default list hides nothing yet (card is unarchived).
    const list0 = await call('kanban_list_cards', {}, auth)
    check('default list includes unarchived card',
      list0.body.cards.some((c) => c.id === id),
      `cards=${list0.body.cards.length}`)

    // 3. Archive: start SSE listener first so we catch the broadcast.
    const ssePromise = collectSse(id, 1500)
    await sleep(100)
    const arch = await call('kanban_archive_card',
      { id, version: v1, ...TOK }, auth)
    check('archive → 200', arch.status === 200, `status=${arch.status}`)
    check('archive returns archived=true', arch.body.archived === true,
      `archived=${arch.body.archived}`)
    check('archive bumps version', arch.body.version === v1 + 1,
      `${v1} → ${arch.body.version}`)
    const v2 = arch.body.version

    // 4. SSE broadcast.
    const sseEvents = await ssePromise
    check('CARD_ARCHIVED SSE emitted',
      sseEvents.some((e) => e.type === 'CARD_ARCHIVED'),
      `events=${sseEvents.map((e) => e.type).join(',')}`)

    // 5. Default list hides archived card.
    const list1 = await call('kanban_list_cards', {}, auth)
    check('default list hides archived card',
      !list1.body.cards.some((c) => c.id === id),
      `cards=${list1.body.cards.length}`)

    // 6. include_archived=true brings it back.
    const list2 = await call('kanban_list_cards', { include_archived: true }, auth)
    const hit = list2.body.cards.find((c) => c.id === id)
    check('include_archived=true returns archived card',
      hit?.archived === true,
      `archived=${hit?.archived}`)

    // 7. archived_only=true returns only archived cards (and overrides include_archived).
    await call('kanban_create_card',
      { title: 'unarch-noise', type: 'task', ...TOK }, auth)
    const list3 = await call('kanban_list_cards', { archived_only: true }, auth)
    check('archived_only=true returns only archived',
      list3.body.cards.length === 1 && list3.body.cards[0].id === id,
      `n=${list3.body.cards.length}`)

    // 8. No-op short circuit: archiving an already-archived card returns
    //    the same version (no extra bump, no audit row).
    const auditBefore = (await readAudit()).length
    const noop = await call('kanban_archive_card',
      { id, version: v2, ...TOK }, auth)
    const auditAfter = (await readAudit()).length
    check('archive no-op keeps version',
      noop.status === 200 && noop.body.version === v2,
      `v=${noop.body.version} (want ${v2})`)
    check('archive no-op writes no audit row',
      auditAfter === auditBefore,
      `before=${auditBefore} after=${auditAfter}`)

    // 9. Stale version on unarchive → 409 with current_card.
    const stale = await call('kanban_unarchive_card',
      { id, version: v1, ...TOK }, auth)
    check('unarchive with stale version → 409',
      stale.status === 409 && stale.body.error === 'conflict',
      `status=${stale.status} current=v${stale.body.current_card?.version}`)

    // 10. Unarchive with correct version.
    const ssePromise2 = collectSse(id, 1500)
    await sleep(100)
    const unarch = await call('kanban_unarchive_card',
      { id, version: v2, ...TOK }, auth)
    check('unarchive → 200', unarch.status === 200, `status=${unarch.status}`)
    check('unarchive returns archived=false',
      unarch.body.archived === false,
      `archived=${unarch.body.archived}`)
    check('unarchive bumps version',
      unarch.body.version === v2 + 1,
      `${v2} → ${unarch.body.version}`)

    const sseEvents2 = await ssePromise2
    check('CARD_UNARCHIVED SSE emitted',
      sseEvents2.some((e) => e.type === 'CARD_UNARCHIVED'),
      `events=${sseEvents2.map((e) => e.type).join(',')}`)

    // 11. Audit log has both ops.
    const audit = await readAudit()
    const ops = audit.filter((e) => e.card_id === id).map((e) => e.op)
    check('audit log records ARCHIVE',
      ops.includes('ARCHIVE'),
      `ops=${ops.join(',')}`)
    check('audit log records UNARCHIVE',
      ops.includes('UNARCHIVE'),
      `ops=${ops.join(',')}`)

  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} archive check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Archive smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
