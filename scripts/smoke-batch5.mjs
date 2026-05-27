#!/usr/bin/env node
// Sprint 02 batch 2 — kanban_create_card / kanban_update_card / 409 / audit + token_log.
import { rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'

const VAULT = '/tmp/kanban-smoke-batch5'
const PORT = 13910
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let mcpCounter = 0
function startMcp() {
  const tag = `mcp${++mcpCounter}`
  const child = spawn('node_modules/.bin/tsx', ['src/index.ts'], {
    env: { ...process.env, VAULT_PATH: VAULT, MCP_HTTP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`[${tag}] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[${tag}-err] ${d}`))
  return child
}
async function stopMcp(child) {
  if (child.exitCode != null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
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
function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg)
  console.log('  ✓ ' + msg)
}
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['src/auth/cli.ts', ...args], {
      env: { ...process.env, VAULT_PATH: VAULT },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
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
async function callTool(name, body, headers) {
  const res = await fetch(`${BASE}/mcp/tool/${name}`, {
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
  const raw = await readFile(path.join(VAULT, '.kanban', 'audit.ndjson'), 'utf8')
  return raw.trim().split('\n').map((l) => JSON.parse(l))
}

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  // Create the agent token first (this also creates the project dir + _meta.json).
  const tokA = extractRawToken((await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:alice'])).stdout)
  const tokMgr = extractRawToken((await runCli(['create', '--role', 'manager', '--actor', 'human:boss'])).stdout)
  const tokB = extractRawToken((await runCli(['create', '--project', 'projB', '--role', 'agent', '--actor', 'agent:bob'])).stdout)

  const mcp = startMcp()
  await waitReady(mcp)

  const authA = { authorization: `Bearer ${tokA}` }
  const authMgr = { authorization: `Bearer ${tokMgr}` }
  const authB = { authorization: `Bearer ${tokB}` }

  try {
    console.log('=== Test 1: create_card validation ===')
    const noType = await callTool('kanban_create_card', { title: 'x', input_tokens: 10, output_tokens: 20, model: 'm' }, authA)
    assert(noType.status === 400, 'missing type → 400')

    const negTokens = await callTool('kanban_create_card', { title: 'x', type: 'task', input_tokens: -1, output_tokens: 0, model: 'm' }, authA)
    assert(negTokens.status === 400, 'negative input_tokens → 400')

    const idIn = await callTool('kanban_create_card', { id: 'card-zzz', title: 'x', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm' }, authA)
    assert(idIn.status === 400 && idIn.body.disallowed_fields?.includes('id'), 'id in payload → 400 disallowed_fields')

    const badStatus = await callTool('kanban_create_card', { title: 'x', type: 'task', status: 'nope', input_tokens: 1, output_tokens: 1, model: 'm' }, authA)
    assert(badStatus.status === 400, 'unknown status → 400')

    console.log('=== Test 2: create_card happy path ===')
    const c1 = await callTool('kanban_create_card', {
      title: 'first card', type: 'task', input_tokens: 100, output_tokens: 200, model: 'claude-opus-4-7',
      tags: ['backend'], priority: 'high', body: 'BODY ONE',
    }, authA)
    assert(c1.status === 200, 'create 200')
    assert(c1.body.id.startsWith('card-') && c1.body.id.length > 5, 'generated id')
    assert(c1.body.version === 1, 'version 1')
    assert(c1.body.position === 1000, 'position 1000 (first in column)')
    assert(c1.body.status === 'backlog', 'default status is first column (backlog)')
    assert(c1.body.total_input_tokens === 100, 'total_input_tokens = 100')
    assert(c1.body.total_output_tokens === 200, 'total_output_tokens = 200')
    assert(c1.body.body === 'BODY ONE', 'body in response')

    const c2 = await callTool('kanban_create_card', {
      title: 'second', type: 'bug', input_tokens: 10, output_tokens: 20, model: 'claude-opus-4-7',
    }, authA)
    assert(c2.body.position === 2000, 'second card in column → position 2000')

    console.log('=== Test 3: idempotency on create ===')
    const reqId = randomUUID()
    const c3a = await callTool('kanban_create_card', {
      title: 'idempotent', type: 'task', input_tokens: 5, output_tokens: 5, model: 'm', request_id: reqId,
    }, authA)
    const c3b = await callTool('kanban_create_card', {
      title: 'idempotent', type: 'task', input_tokens: 5, output_tokens: 5, model: 'm', request_id: reqId,
    }, authA)
    assert(c3a.body.id === c3b.body.id, 'retry returns same card id')

    // Verify only one file exists for the idempotent card
    const { readdirSync } = await import('node:fs')
    const files = readdirSync(path.join(VAULT, '.kanban-data', 'projA')).filter((f) => f.endsWith('.md'))
    assert(files.length === 3, 'exactly 3 .md files (c1, c2, idempotent — no duplicates)')

    console.log('=== Test 4: update_card validation ===')
    const u1 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 1, input_tokens: 10, output_tokens: 20, model: 'm',
      owner: 'someone',
    }, authA)
    assert(u1.status === 400 && u1.body.disallowed_fields?.includes('owner'), 'agent sends owner → 400')

    const u2 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 1, input_tokens: 10, output_tokens: 20, model: 'm',
      type: 'changed',
    }, authA)
    assert(u2.status === 400 && u2.body.disallowed_fields?.includes('type'), 'type in update → 400')

    console.log('=== Test 5: update_card happy path ===')
    const u3 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 1, input_tokens: 50, output_tokens: 75, model: 'm',
      title: 'first card v2', priority: 'low',
    }, authA)
    assert(u3.status === 200, 'update 200')
    assert(u3.body.version === 2, 'version incremented')
    assert(u3.body.title === 'first card v2', 'title replaced')
    assert(u3.body.priority === 'low', 'priority replaced')
    assert(u3.body.total_input_tokens === 150, 'total_input_tokens accumulated 100+50')
    assert(u3.body.total_output_tokens === 275, 'total_output_tokens accumulated 200+75')

    console.log('=== Test 6: status change repositions to bottom of destination ===')
    const u4 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 2, input_tokens: 1, output_tokens: 1, model: 'm',
      status: 'in-progress',
    }, authA)
    assert(u4.status === 200, 'status change 200')
    assert(u4.body.status === 'in-progress', 'status moved')
    assert(u4.body.position === 1000, 'position reset to MAX+1000 (empty column → 1000)')

    console.log('=== Test 7: 409 Conflict ===')
    const u5 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 99, input_tokens: 1, output_tokens: 1, model: 'm',
      title: 'will conflict',
    }, authA)
    assert(u5.status === 409, 'stale version → 409')
    assert(u5.body.your_version === 99, '409 includes your_version')
    assert(u5.body.current_version === 3, '409 includes current_version')
    assert(u5.body.conflicting_fields.includes('title'), '409 lists title as conflicting')
    assert(typeof u5.body.current_card.body === 'string', '409 current_card has body')

    console.log('=== Test 8: disallowed-fields wins over version check ===')
    const u6 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 99, input_tokens: 1, output_tokens: 1, model: 'm',
      owner: 'x',
    }, authA)
    assert(u6.status === 400, 'disallowed > version check')

    console.log('=== Test 9: manager can set owner ===')
    const u7 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 3, input_tokens: 1, output_tokens: 1, model: 'm',
      owner: 'alice',
    }, authMgr)
    assert(u7.status === 200 && u7.body.owner === 'alice', 'manager sets owner')

    console.log('=== Test 9b: manager create requires project ===')
    const mgrNoProj = await callTool('kanban_create_card', {
      title: 'm-card', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
    }, authMgr)
    assert(mgrNoProj.status === 400, 'manager create without project → 400')

    const mgrCreate = await callTool('kanban_create_card', {
      project: 'projB', title: 'm-card', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
    }, authMgr)
    assert(mgrCreate.status === 200 && mgrCreate.body.project === 'projB', 'manager creates card in projB')

    console.log('=== Test 10: cross-project update → 404 ===')
    const cross = await callTool('kanban_update_card', {
      id: c1.body.id, version: 4, input_tokens: 1, output_tokens: 1, model: 'm', title: 'x',
    }, authB)
    assert(cross.status === 404, 'agent of projB sees card-of-projA → 404')

    console.log('=== Test 11: audit log + token_log ===')
    const audit = await readAudit()
    const creates = audit.filter((e) => e.op === 'CREATE')
    assert(creates.length === 4, '4 CREATE entries (c1, c2, idempotent, manager projB)')
    assert(creates[0].input_tokens === 100 && creates[0].model === 'claude-opus-4-7', 'CREATE entry has tokens + model')
    const updates = audit.filter((e) => e.op === 'UPDATE')
    assert(updates.length >= 3, 'UPDATE entries present')
    assert(Array.isArray(updates[0].changed_fields), 'UPDATE entry has changed_fields')

    // Inspect token_log SQLite
    const db = new Database(path.join(VAULT, '.kanban', 'db.sqlite'))
    const tokenRows = db.prepare('SELECT * FROM token_log ORDER BY id').all()
    db.close()
    assert(tokenRows.length === creates.length + updates.length, 'token_log row count = audit mutations')
    const totalInput = tokenRows.reduce((s, r) => s + r.input_tokens, 0)
    assert(totalInput === 100 + 10 + 5 + 1 + 50 + 1 + 1, 'token_log totals match')

    console.log('=== Test 12: idempotent retry does NOT add token_log row ===')
    const tokCountBefore = tokenRows.length
    const retryReqId = randomUUID()
    const r1 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 4, input_tokens: 7, output_tokens: 7, model: 'm',
      title: 'retry test', request_id: retryReqId,
    }, authMgr)
    assert(r1.status === 200, 'first attempt of idempotent update')
    const r2 = await callTool('kanban_update_card', {
      id: c1.body.id, version: 4, input_tokens: 7, output_tokens: 7, model: 'm',
      title: 'retry test', request_id: retryReqId,
    }, authMgr)
    assert(r2.body.version === r1.body.version, 'retry returns same version (no double increment)')

    const db2 = new Database(path.join(VAULT, '.kanban', 'db.sqlite'))
    const tokenRowsAfter = db2.prepare('SELECT COUNT(*) AS n FROM token_log').get()
    db2.close()
    assert(tokenRowsAfter.n === tokCountBefore + 1, 'token_log added only 1 row despite 2 calls')

    console.log('\nALL TESTS PASSED')
  } finally {
    await stopMcp(mcp)
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
