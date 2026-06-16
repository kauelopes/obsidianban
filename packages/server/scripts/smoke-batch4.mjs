#!/usr/bin/env node
// Sprint 02 batch 1 — exercises kanban_list_cards and kanban_get_card.
// Cards are seeded by writing .md files directly; startup reconciliation
// indexes them into SQLite before the smoke tests run.
import { rm, mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-batch4'
const PORT = 13900
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

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['src/auth/cli.ts', ...args], {
      env: { ...process.env, VAULT_PATH: VAULT, ...env },
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

function seedCard({ project, id, title, status, position, tags = [], assignedTo = null, body = '' }) {
  const now = '2026-01-01T00:00:00.000Z'
  const fm = [
    `id: ${id}`,
    `project: ${project}`,
    `title: ${title}`,
    `status: ${status}`,
    `type: task`,
    `version: 1`,
    `position: ${position}`,
    `priority: medium`,
    `tags:`,
    ...tags.map((t) => `  - ${t}`),
    `due_date: null`,
    `assigned_to: ${assignedTo === null ? 'null' : assignedTo}`,
    `owner: null`,
    `agent_notes: null`,
    `total_input_tokens: 0`,
    `total_output_tokens: 0`,
    `created_at: "${now}"`,
    `updated_at: "${now}"`,
    `created_by: "agent:seed"`,
    `updated_by: "agent:seed"`,
  ].join('\n')
  return `---\n${fm}\n---\n${body}`
}

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  await mkdir(path.join(VAULT, 'kanban-data', 'projA'), { recursive: true })
  await mkdir(path.join(VAULT, 'kanban-data', 'projB'), { recursive: true })

  // Seed _meta.json for both projects (otherwise reconciliation has no project list)
  // ensureLayout creates kanban-data but the project dirs exist via the writes above.
  // _meta.json gets auto-created by ensureProject when the CLI creates a token for the project.

  // Seed cards: projA backlog (3) + projA in-progress (1) + projB backlog (1)
  await writeFile(
    path.join(VAULT, 'kanban-data', 'projA', 'card-a1.md'),
    seedCard({ project: 'projA', id: 'card-a1', title: 'A1 backlog first', status: 'backlog', position: 1000, tags: ['backend', 'auth'], body: 'BODY A1' }),
  )
  await writeFile(
    path.join(VAULT, 'kanban-data', 'projA', 'card-a2.md'),
    seedCard({ project: 'projA', id: 'card-a2', title: 'A2 backlog second', status: 'backlog', position: 2000, tags: ['backend'], assignedTo: 'alice' }),
  )
  await writeFile(
    path.join(VAULT, 'kanban-data', 'projA', 'card-a3.md'),
    seedCard({ project: 'projA', id: 'card-a3', title: 'A3 backlog third', status: 'backlog', position: 3000, tags: ['backend', 'auth'] }),
  )
  await writeFile(
    path.join(VAULT, 'kanban-data', 'projA', 'card-a4.md'),
    seedCard({ project: 'projA', id: 'card-a4', title: 'A4 in progress', status: 'in-progress', position: 1000 }),
  )
  await writeFile(
    path.join(VAULT, 'kanban-data', 'projB', 'card-b1.md'),
    seedCard({ project: 'projB', id: 'card-b1', title: 'B1 backlog', status: 'backlog', position: 1000, tags: ['backend'] }),
  )

  console.log('=== Setup: create tokens for projA, projB and a manager ===')
  const tokA = extractRawToken((await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:a'])).stdout)
  const tokB = extractRawToken((await runCli(['create', '--project', 'projB', '--role', 'agent', '--actor', 'agent:b'])).stdout)
  const tokMgr = extractRawToken((await runCli(['create', '--role', 'manager', '--actor', 'human:boss'])).stdout)

  const mcp = startMcp()
  await waitReady(mcp)

  try {
    console.log('=== Test 1: list_cards isolation per project ===')
    const listA = await callTool('kanban_list_cards', {}, { authorization: `Bearer ${tokA}` })
    assert(listA.status === 200, 'projA agent: list 200')
    const idsA = listA.body.cards.map((c) => c.id)
    assert(idsA.length === 4, '  projA agent sees 4 cards')
    assert(idsA.every((id) => id.startsWith('card-a')), '  no card-b leak into projA results')

    const listB = await callTool('kanban_list_cards', {}, { authorization: `Bearer ${tokB}` })
    assert(listB.body.cards.length === 1, 'projB agent sees only its 1 card')
    assert(listB.body.cards[0].id === 'card-b1', '  exact projB card returned')

    console.log('=== Test 2: default ordering = position ASC ===')
    const firstThree = listA.body.cards
      .filter((c) => c.status === 'backlog')
      .map((c) => c.id)
    assert(JSON.stringify(firstThree) === JSON.stringify(['card-a1', 'card-a2', 'card-a3']), 'backlog ordered by position ASC')

    console.log('=== Test 3: filter by status ===')
    const inProg = await callTool('kanban_list_cards', { status: 'in-progress' }, { authorization: `Bearer ${tokA}` })
    assert(inProg.body.cards.length === 1 && inProg.body.cards[0].id === 'card-a4', 'status=in-progress returns only card-a4')

    console.log('=== Test 4: tags AND filter ===')
    const tagAuth = await callTool('kanban_list_cards', { tags: ['backend', 'auth'] }, { authorization: `Bearer ${tokA}` })
    const ids = tagAuth.body.cards.map((c) => c.id).sort()
    assert(JSON.stringify(ids) === JSON.stringify(['card-a1', 'card-a3']), 'tags AND [backend, auth] returns 2 cards (a2 lacks auth)')

    console.log('=== Test 5: assigned_to filter ===')
    const assigned = await callTool('kanban_list_cards', { assigned_to: 'alice' }, { authorization: `Bearer ${tokA}` })
    assert(assigned.body.cards.length === 1 && assigned.body.cards[0].id === 'card-a2', 'assigned_to=alice → card-a2')

    console.log('=== Test 6: limit + offset paging ===')
    const page1 = await callTool('kanban_list_cards', { status: 'backlog', limit: 2, offset: 0 }, { authorization: `Bearer ${tokA}` })
    const page2 = await callTool('kanban_list_cards', { status: 'backlog', limit: 2, offset: 2 }, { authorization: `Bearer ${tokA}` })
    assert(page1.body.cards.map((c) => c.id).join(',') === 'card-a1,card-a2', 'page1 = a1,a2')
    assert(page2.body.cards.map((c) => c.id).join(',') === 'card-a3', 'page2 = a3')

    console.log('=== Test 7: invalid params ===')
    const badLimit = await callTool('kanban_list_cards', { limit: 999 }, { authorization: `Bearer ${tokA}` })
    assert(badLimit.status === 400 && badLimit.body.error === 'invalid_field', 'limit > 200 → 400')

    const badOrder = await callTool('kanban_list_cards', { order_by: 'random' }, { authorization: `Bearer ${tokA}` })
    assert(badOrder.status === 400, 'invalid order_by → 400')

    console.log('=== Test 8: manager sees all projects ===')
    const mgrAll = await callTool('kanban_list_cards', {}, { authorization: `Bearer ${tokMgr}` })
    assert(mgrAll.body.cards.length === 5, 'manager sees all 5 cards across projects')

    console.log('=== Test 9: get_card returns body from .md ===')
    const getA1 = await callTool('kanban_get_card', { id: 'card-a1' }, { authorization: `Bearer ${tokA}` })
    assert(getA1.status === 200, 'get_card 200')
    assert(getA1.body.body.includes('BODY A1'), '  body comes from .md, not SQLite')
    assert(getA1.body.id === 'card-a1', '  card metadata returned')

    console.log('=== Test 10: cross-project access → 404 (BR-03) ===')
    const cross = await callTool('kanban_get_card', { id: 'card-b1' }, { authorization: `Bearer ${tokA}` })
    assert(cross.status === 404, 'projA agent reading card-b1 → 404 (not 403)')

    console.log('=== Test 11: missing id ===')
    const missing = await callTool('kanban_get_card', {}, { authorization: `Bearer ${tokA}` })
    assert(missing.status === 400, 'missing id → 400')

    const ghost = await callTool('kanban_get_card', { id: 'card-zzz' }, { authorization: `Bearer ${tokA}` })
    assert(ghost.status === 404, 'unknown id → 404')

    console.log('=== Test 12: manager reads any project ===')
    const mgrGet = await callTool('kanban_get_card', { id: 'card-b1' }, { authorization: `Bearer ${tokMgr}` })
    assert(mgrGet.status === 200 && mgrGet.body.id === 'card-b1', 'manager reads card-b1')

    console.log('\nALL TESTS PASSED')
  } finally {
    await stopMcp(mcp)
  }
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
