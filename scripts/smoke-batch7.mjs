#!/usr/bin/env node
// Sprint 03 batch 1 — GET /metrics endpoint.
import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const VAULT = '/tmp/kanban-smoke-batch7'
const PORT = 13921
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startMcp() {
  const child = spawn('node_modules/.bin/tsx', ['src/index.ts'], {
    env: { ...process.env, VAULT_PATH: VAULT, MCP_HTTP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (d) => process.stdout.write(`[mcp] ${d}`))
  child.stderr.on('data', (d) => process.stderr.write(`[mcp-err] ${d}`))
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
async function getMetrics(query = '') {
  const res = await fetch(`${BASE}/metrics${query}`)
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, body: json, raw: text }
}

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const tokA = extractRawToken((await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:alice'])).stdout)
  const tokB = extractRawToken((await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:bob'])).stdout)
  const authA = { authorization: `Bearer ${tokA}` }
  const authB = { authorization: `Bearer ${tokB}` }

  const mcp = startMcp()
  await waitReady(mcp)

  try {
    console.log('=== Test 1: empty token_log → zeros ===')
    const empty = await getMetrics()
    assert(empty.status === 200, 'empty 200')
    assert(empty.body.summary.total_input_tokens === 0, 'empty summary.total_input_tokens = 0')
    assert(empty.body.summary.total_output_tokens === 0, 'empty summary.total_output_tokens = 0')
    assert(empty.body.summary.total_ops === 0, 'empty summary.total_ops = 0')
    assert(Array.isArray(empty.body.by_type) && empty.body.by_type.length === 0, 'by_type is empty array')
    assert(Array.isArray(empty.body.by_day) && empty.body.by_day.length === 0, 'by_day is empty array')
    assert(Array.isArray(empty.body.by_model) && empty.body.by_model.length === 0, 'by_model is empty array')
    assert(Array.isArray(empty.body.by_agent) && empty.body.by_agent.length === 0, 'by_agent is empty array')
    assert(Array.isArray(empty.body.by_operation) && empty.body.by_operation.length === 0, 'by_operation is empty array')

    console.log('=== Setup: 4 CREATE + 2 UPDATE + 1 MOVE across two agents/types/models ===')
    // alice creates 3 task cards w/ model "m1" (5,10 each)
    const c1 = await callTool('kanban_create_card', { title: 'c1', type: 'task', input_tokens: 5, output_tokens: 10, model: 'm1' }, authA)
    assert(c1.status === 200, 'c1 created')
    const c2 = await callTool('kanban_create_card', { title: 'c2', type: 'task', input_tokens: 5, output_tokens: 10, model: 'm1' }, authA)
    const c3 = await callTool('kanban_create_card', { title: 'c3', type: 'task', input_tokens: 5, output_tokens: 10, model: 'm1' }, authA)
    // bob creates 1 bug card w/ model "m2" (7,14)
    const c4 = await callTool('kanban_create_card', { title: 'c4', type: 'bug', input_tokens: 7, output_tokens: 14, model: 'm2' }, authB)
    assert(c4.status === 200, 'c4 created')
    // alice updates c1 and c2 (2,3 each, model m1)
    await callTool('kanban_update_card', { id: c1.body.id, version: 1, title: 'c1-upd', input_tokens: 2, output_tokens: 3, model: 'm1' }, authA)
    await callTool('kanban_update_card', { id: c2.body.id, version: 1, title: 'c2-upd', input_tokens: 2, output_tokens: 3, model: 'm1' }, authA)
    // bob moves c4 (1,2)
    await callTool('kanban_move_card', { id: c4.body.id, version: 1, to_status: 'in-progress', input_tokens: 1, output_tokens: 2, model: 'm2' }, authB)

    // Expected totals:
    //   CREATE 3x (5,10) by alice/m1/task  + CREATE 1x (7,14) by bob/m2/bug
    //   UPDATE 2x (2,3) by alice/m1/task
    //   MOVE   1x (1,2) by bob/m2/bug
    //   total_input  = 15 + 7 + 4 + 1 = 27
    //   total_output = 30 + 14 + 6 + 2 = 52
    //   total_ops    = 7
    void c3

    console.log('=== Test 2: summary totals ===')
    const m = await getMetrics()
    assert(m.status === 200, 'metrics 200')
    assert(m.body.summary.total_input_tokens === 27, `summary.total_input_tokens=${m.body.summary.total_input_tokens} (want 27)`)
    assert(m.body.summary.total_output_tokens === 52, `summary.total_output_tokens=${m.body.summary.total_output_tokens} (want 52)`)
    assert(m.body.summary.total_ops === 7, `summary.total_ops=${m.body.summary.total_ops} (want 7)`)

    console.log('=== Test 3: by_type ===')
    const byTask = m.body.by_type.find((r) => r.type === 'task')
    const byBug = m.body.by_type.find((r) => r.type === 'bug')
    assert(byTask && byTask.input_tokens === 19 && byTask.output_tokens === 36 && byTask.ops === 5, `task agg: ${JSON.stringify(byTask)}`)
    assert(byBug && byBug.input_tokens === 8 && byBug.output_tokens === 16 && byBug.ops === 2, `bug agg: ${JSON.stringify(byBug)}`)

    console.log('=== Test 4: by_model ===')
    const m1 = m.body.by_model.find((r) => r.model === 'm1')
    const m2 = m.body.by_model.find((r) => r.model === 'm2')
    assert(m1 && m1.input_tokens === 19 && m1.output_tokens === 36, `m1 agg: ${JSON.stringify(m1)}`)
    assert(m2 && m2.input_tokens === 8 && m2.output_tokens === 16, `m2 agg: ${JSON.stringify(m2)}`)

    console.log('=== Test 5: by_agent ===')
    const alice = m.body.by_agent.find((r) => r.actor === 'agent:alice')
    const bob = m.body.by_agent.find((r) => r.actor === 'agent:bob')
    assert(alice && alice.input_tokens === 19 && alice.output_tokens === 36, `alice agg: ${JSON.stringify(alice)}`)
    assert(bob && bob.input_tokens === 8 && bob.output_tokens === 16, `bob agg: ${JSON.stringify(bob)}`)

    console.log('=== Test 6: by_operation ===')
    const create = m.body.by_operation.find((r) => r.op === 'CREATE')
    const update = m.body.by_operation.find((r) => r.op === 'UPDATE')
    const move = m.body.by_operation.find((r) => r.op === 'MOVE')
    assert(create && create.count === 4 && create.input_tokens === 22 && create.output_tokens === 44, `CREATE: ${JSON.stringify(create)}`)
    assert(update && update.count === 2 && update.input_tokens === 4 && update.output_tokens === 6, `UPDATE: ${JSON.stringify(update)}`)
    assert(move && move.count === 1 && move.input_tokens === 1 && move.output_tokens === 2, `MOVE: ${JSON.stringify(move)}`)

    console.log('=== Test 7: by_day (single day expected) ===')
    assert(m.body.by_day.length === 1, `by_day.length=${m.body.by_day.length} (want 1, same-day run)`)
    const today = m.body.by_day[0]
    assert(/^\d{4}-\d{2}-\d{2}$/.test(today.date), 'by_day.date format YYYY-MM-DD')
    assert(today.input_tokens === 27 && today.output_tokens === 52, `today agg: ${JSON.stringify(today)}`)

    console.log('=== Test 8: date filters ===')
    const past = await getMetrics('?from_date=2000-01-01&to_date=2000-01-02')
    assert(past.status === 200, 'past 200')
    assert(past.body.summary.total_ops === 0, 'past range → 0 ops')
    assert(past.body.by_type.length === 0, 'past range → empty by_type')

    const future = await getMetrics(`?from_date=${today.date}&to_date=${today.date}`)
    assert(future.status === 200, 'today range 200')
    assert(future.body.summary.total_ops === 7, 'today range → 7 ops')

    console.log('=== Test 9: invalid date format → 400 ===')
    const bad = await getMetrics('?from_date=notadate')
    assert(bad.status === 400, `bad date → 400 (got ${bad.status})`)
    assert(bad.body.error === 'invalid_field', 'error=invalid_field')

    console.log('=== Test 10: no auth required ===')
    // (the GET above had no Authorization header — already validated)
    assert(true, '/metrics accessible without Bearer token')

    console.log('\n✅ All metrics smoke tests passed.')
  } finally {
    await stopMcp(mcp)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
