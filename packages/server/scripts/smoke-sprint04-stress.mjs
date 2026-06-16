#!/usr/bin/env node
// Sprint 04 — TASK-34: stress reconciliation with 1000+ cards.
// Scenario A: 1000 cards via MCP → delete db.sqlite → restart → all 1000
//             queryable + SQLITE_REBUILT logged with card_count=1000.
// Scenario B: 500 from MCP + 500 hand-written .md → restart → 1000 present.
// Scenario C: 1000 in SQLite, delete 200 .md → restart → 800 left,
//             ORPHAN_REMOVED logged 200 times.
//
// For speed, MCP creates run in parallel batches. Hand-written .md files
// in scenario B follow the canonical frontmatter schema from serialize.ts.

import { rm, readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-sprint04-stress'
const PORT = 13932
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'projA'
const PARALLEL = 25
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
  await Promise.race([exited, sleep(3000).then(() => { try { child.kill('SIGKILL') } catch {} })])
}
async function waitReady(child, timeoutMs = 15000) {
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
async function listAllCards(auth) {
  const all = []
  let offset = 0
  while (true) {
    const res = await callTool('kanban_list_cards', { project: PROJECT, limit: 200, offset }, auth)
    if (res.status !== 200) throw new Error(`list_cards failed: ${res.status} ${res.raw}`)
    all.push(...res.body.cards)
    if (res.body.cards.length < 200) break
    offset += 200
  }
  return all
}
async function readAudit() {
  const auditPath = path.join(VAULT, '.kanban', 'audit.ndjson')
  const raw = await readFile(auditPath, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function createBulk(auth, count, titlePrefix) {
  const tokens = { input_tokens: 0, output_tokens: 0, model: 'stress' }
  let done = 0
  for (let start = 0; start < count; start += PARALLEL) {
    const batch = []
    for (let i = start; i < Math.min(start + PARALLEL, count); i++) {
      batch.push(callTool(
        'kanban_create_card',
        { title: `${titlePrefix}-${i}`, type: 'task', status: 'backlog', ...tokens },
        auth,
      ))
    }
    const results = await Promise.all(batch)
    for (const r of results) {
      if (r.status !== 200) throw new Error(`bulk create failed: ${r.status} ${r.raw}`)
    }
    done += batch.length
    if (done % 100 === 0) console.log(`  ... created ${done}/${count}`)
  }
}

function manualCardYaml({ id, project, title, position }) {
  const now = new Date().toISOString()
  return `---
id: ${id}
project: ${project}
title: ${title}
status: backlog
type: task
version: 1
position: ${position}
priority: medium
tags: []
due_date: null
assigned_to: null
owner: null
agent_notes: null
total_input_tokens: 0
total_output_tokens: 0
created_at: '${now}'
updated_at: '${now}'
created_by: 'manual:smoke'
updated_by: 'manual:smoke'
---
`
}

async function listMdFiles(project) {
  const dir = path.join(VAULT, 'kanban-data', project)
  const entries = await readdir(dir).catch(() => [])
  return entries.filter((n) => n.endsWith('.md') && !n.startsWith('_'))
}

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const tok = extractRawToken((await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:stress',
  ])).stdout)
  const auth = { authorization: `Bearer ${tok}` }

  // ── Scenario A ─────────────────────────────────────────────
  console.log('=== Scenario A: 1000 cards → delete SQLite → restart → SQLITE_REBUILT ===')
  let mcp = startMcp()
  await waitReady(mcp)
  try {
    const t0 = Date.now()
    await createBulk(auth, 1000, 'A')
    console.log(`  ... bulk create took ${Date.now() - t0}ms`)
    const list1 = await listAllCards(auth)
    assert(list1.length === 1000, `list returned 1000 (got ${list1.length})`)
  } finally {
    await stopMcp(mcp)
  }

  await unlink(path.join(VAULT, '.kanban', 'db.sqlite'))
  console.log('  ✓ db.sqlite deleted')
  const beforeAuditA = (await readAudit()).length

  mcp = startMcp()
  await waitReady(mcp)
  try {
    const afterAudit = await readAudit()
    const rebuilt = afterAudit.slice(beforeAuditA).filter((e) => e.op === 'SQLITE_REBUILT')
    assert(rebuilt.length === 1, `SQLITE_REBUILT logged once (got ${rebuilt.length})`)
    assert(
      rebuilt[0].card_count === 1000,
      `SQLITE_REBUILT card_count=1000 (got ${rebuilt[0].card_count})`,
    )
    const list2 = await listAllCards(auth)
    assert(list2.length === 1000, `post-restart list=1000 (got ${list2.length})`)
  } finally {
    await stopMcp(mcp)
  }

  // ── Scenario B ─────────────────────────────────────────────
  console.log('=== Scenario B: 500 manual .md added → restart → 1500 total ===')
  // The vault already has 1000 cards from A. Add 500 hand-written ones.
  const projDir = path.join(VAULT, 'kanban-data', PROJECT)
  await mkdir(projDir, { recursive: true })
  const now = Date.now()
  for (let i = 0; i < 500; i++) {
    const id = `manual-${String(i).padStart(4, '0')}`
    const title = `manual-${i}`
    const basename = `manual-${String(i).padStart(4, '0')}`
    const yaml = manualCardYaml({ id, project: PROJECT, title, position: (now + i) * 1000 })
    await writeFile(path.join(projDir, `${basename}.md`), yaml, 'utf8')
  }
  console.log('  ✓ 500 manual .md written')
  await unlink(path.join(VAULT, '.kanban', 'db.sqlite'))
  console.log('  ✓ db.sqlite deleted again to force full rebuild')
  const beforeAuditB = (await readAudit()).length
  mcp = startMcp()
  await waitReady(mcp)
  try {
    const afterAudit = await readAudit()
    const rebuilt = afterAudit.slice(beforeAuditB).filter((e) => e.op === 'SQLITE_REBUILT')
    assert(rebuilt.length === 1, `SQLITE_REBUILT logged once (got ${rebuilt.length})`)
    assert(
      rebuilt[0].card_count === 1500,
      `SQLITE_REBUILT card_count=1500 (got ${rebuilt[0].card_count})`,
    )
    const list3 = await listAllCards(auth)
    assert(list3.length === 1500, `merged list=1500 (got ${list3.length})`)
    const sample = list3.find((c) => c.id === 'manual-0042')
    assert(sample && sample.title === 'manual-42', 'manual card queryable by id')
  } finally {
    await stopMcp(mcp)
  }

  // ── Scenario C ─────────────────────────────────────────────
  console.log('=== Scenario C: delete 200 .md → restart → ORPHAN_REMOVED 200x ===')
  const allMd = await listMdFiles(PROJECT)
  assert(allMd.length === 1500, `pre-delete .md count=1500 (got ${allMd.length})`)
  const toDelete = allMd.slice(0, 200)
  await Promise.all(toDelete.map((n) => unlink(path.join(projDir, n))))
  console.log('  ✓ 200 .md unlinked')
  const beforeAuditC = (await readAudit()).length
  mcp = startMcp()
  await waitReady(mcp)
  try {
    const afterAudit = await readAudit()
    const removed = afterAudit.slice(beforeAuditC).filter((e) => e.op === 'ORPHAN_REMOVED')
    assert(removed.length === 200, `ORPHAN_REMOVED count=200 (got ${removed.length})`)
    const list4 = await listAllCards(auth)
    assert(list4.length === 1300, `post-orphan list=1300 (got ${list4.length})`)
  } finally {
    await stopMcp(mcp)
  }

  console.log('\n✅ Sprint 04 TASK-34 stress smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
