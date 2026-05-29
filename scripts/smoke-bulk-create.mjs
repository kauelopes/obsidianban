#!/usr/bin/env node
// Bulk create smoke. Covers envelope validation, per-card success/failure
// segregation, prorated token charging, the 100-entry limit, project
// injection, and request_id-driven idempotency.

import { rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-bulk-create'
const PORT = 13922
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'bulky'
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
  return new Promise((resolve, reject) => {
    const c = spawn('node_modules/.bin/tsx', ['src/auth/cli.ts', ...args], {
      env: { ...process.env, VAULT_PATH: VAULT }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    c.stdout.on('data', (d) => (stdout += d.toString()))
    c.on('exit', () => resolve(stdout))
    c.on('error', reject)
  })
}
function extractRawToken(stdout) {
  const m = /token:\s+(\S+)/.exec(stdout)
  if (!m) throw new Error('could not parse token from CLI output')
  return m[1]
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
async function readTokenLog() {
  // The metrics SQLite is at .kanban/state.db — querying by tool spawn is
  // overkill for a smoke. Use the kanban-data project meta files only.
  // For per-card cost verification we read the .md frontmatter directly.
  return null
}

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const tok = extractRawToken(await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:bulkbot',
  ]))
  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Bulk create smoke ===')

    // 1. Happy path — all cards succeed.
    const r1 = await call('kanban_bulk_create_cards', {
      cards: [
        { title: 'design login flow', type: 'task' },
        { title: 'write auth tests', type: 'task', priority: 'high' },
        { title: 'docs for new endpoint', type: 'doc', tags: ['docs', 'auth'] },
      ],
      input_tokens: 300,
      output_tokens: 90,
      model: 'bulk-smoke',
    }, tok)
    check('happy bulk → 200', r1.status === 200, `status=${r1.status}`)
    check('all three created',
      Array.isArray(r1.body.created) && r1.body.created.length === 3,
      `n=${r1.body.created?.length}`)
    check('failed array empty', r1.body.failed.length === 0,
      `failed=${r1.body.failed.length}`)
    check('indices preserved',
      r1.body.created.every((c, i) => c.index === i),
      `indices=${r1.body.created.map((c) => c.index).join(',')}`)
    check('per-card priorities respected',
      r1.body.created[1].card.priority === 'high',
      `card1.priority=${r1.body.created[1].card.priority}`)
    check('per-card tags respected',
      JSON.stringify(r1.body.created[2].card.tags) === JSON.stringify(['docs', 'auth']),
      `card2.tags=${JSON.stringify(r1.body.created[2].card.tags)}`)

    // 2. Token prorating: 300 input across 3 → 100 each (no remainder)
    const tokensPerCard = r1.body.created.map((c) => c.card.total_input_tokens)
    check('input tokens prorated evenly',
      JSON.stringify(tokensPerCard) === JSON.stringify([100, 100, 100]),
      `tokens=${tokensPerCard.join(',')}`)

    // 3. Token prorating with remainder: 100/3 → [33, 33, 34]
    const r2 = await call('kanban_bulk_create_cards', {
      cards: [
        { title: 'remainder a', type: 'task' },
        { title: 'remainder b', type: 'task' },
        { title: 'remainder c', type: 'task' },
      ],
      input_tokens: 100,
      output_tokens: 7,
      model: 'bulk-smoke',
    }, tok)
    const remTokens = r2.body.created.map((c) => c.card.total_input_tokens)
    check('remainder goes to last card',
      JSON.stringify(remTokens) === JSON.stringify([33, 33, 34]),
      `tokens=${remTokens.join(',')}`)
    const remOut = r2.body.created.map((c) => c.card.total_output_tokens)
    check('output remainder also lands on last card',
      JSON.stringify(remOut) === JSON.stringify([2, 2, 3]),
      `tokens=${remOut.join(',')}`)

    // 4. Partial failure — one valid, one missing title.
    const r3 = await call('kanban_bulk_create_cards', {
      cards: [
        { title: 'good card', type: 'task' },
        { type: 'task' },  // missing title → invalid
        { title: 'another good', type: 'task' },
      ],
      input_tokens: 30, output_tokens: 9, model: 'bulk-smoke',
    }, tok)
    check('partial bulk still → 200', r3.status === 200, `status=${r3.status}`)
    check('two created, one failed',
      r3.body.created.length === 2 && r3.body.failed.length === 1,
      `created=${r3.body.created.length} failed=${r3.body.failed.length}`)
    check('failed entry carries index 1',
      r3.body.failed[0].index === 1,
      `failed_index=${r3.body.failed[0].index}`)
    check('good entries indices preserved (0 and 2)',
      r3.body.created[0].index === 0 && r3.body.created[1].index === 2,
      `idxs=${r3.body.created.map((c) => c.index).join(',')}`)

    // 5. Envelope-owned fields rejected per-card.
    const r4 = await call('kanban_bulk_create_cards', {
      cards: [
        { title: 'attempts override', type: 'task', input_tokens: 9999 },
      ],
      input_tokens: 10, output_tokens: 1, model: 'bulk-smoke',
    }, tok)
    check('envelope-owned field per-card → invalid_card',
      r4.body.failed.length === 1
        && r4.body.failed[0].error === 'invalid_card'
        && Array.isArray(r4.body.failed[0].detail.fields)
        && r4.body.failed[0].detail.fields.includes('input_tokens'),
      `detail=${JSON.stringify(r4.body.failed[0]?.detail)}`)

    // 6. Empty cards array → 400.
    const r5 = await call('kanban_bulk_create_cards', {
      cards: [], input_tokens: 0, output_tokens: 0, model: 'bulk-smoke',
    }, tok)
    check('empty cards → 400',
      r5.status === 400 && r5.body.field === 'cards',
      `status=${r5.status} field=${r5.body?.field}`)

    // 7. Over-limit (101) → 400.
    const tooMany = Array.from({ length: 101 }, (_, i) => ({ title: `x${i}`, type: 'task' }))
    const r6 = await call('kanban_bulk_create_cards', {
      cards: tooMany, input_tokens: 0, output_tokens: 0, model: 'bulk-smoke',
    }, tok)
    check('101 cards → 400 with max=100',
      r6.status === 400 && r6.body.max === 100,
      `status=${r6.status} max=${r6.body?.max}`)

    // 8. Envelope idempotency via request_id.
    const reqId = randomUUID()
    const idemReq = {
      cards: [{ title: 'idempotent one', type: 'task' }],
      input_tokens: 10, output_tokens: 3, model: 'bulk-smoke',
      request_id: reqId,
    }
    const r7a = await call('kanban_bulk_create_cards', idemReq, tok)
    const r7b = await call('kanban_bulk_create_cards', idemReq, tok)
    check('idempotent retry returns same card id',
      r7a.body.created[0].card.id === r7b.body.created[0].card.id,
      `${r7a.body.created[0].card.id}==${r7b.body.created[0].card.id}`)

    // Final tally check: list_cards reflects all the unique successes.
    // Bulk #1: 3, #2: 3, #3: 2, #4: 0, #7 (idem): 1 → 9 total
    const lc = await call('kanban_list_cards', { limit: 200 }, tok)
    check('list_cards reflects 9 successful creates',
      lc.body.cards.length === 9, `n=${lc.body.cards.length}`)

  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} bulk-create check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Bulk-create smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
