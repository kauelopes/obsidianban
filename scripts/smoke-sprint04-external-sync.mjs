#!/usr/bin/env node
// Sprint 04 — TASK-33: external sync simulation.
// Scenario A: external write to .md while MCP is live → watcher detects,
// audit log gains a tracked-edit entry, agent's stale-version update → 409.
// Scenario B: MCP offline → .md mutated → MCP restart → RECONCILED logged.
//
// NOTE — naming discrepancy with PRD: the PRD uses EXTERNAL_MUTATION as the
// label for sync-driven writes. In the current implementation, the watcher
// cannot distinguish "sync tool" from "human in Obsidian" — both surface as
// HUMAN_EDIT for tracked cards. EXTERNAL_MUTATION is reserved for writes
// referencing card IDs not present in SQLite. We assert on the canonical
// codes; the sprint-04 architecture doc explains the spec/code mapping.

import { rm, readFile, writeFile, readdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-sprint04-sync'
const PORT = 13931
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'projA'
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
async function readAudit() {
  const auditPath = path.join(VAULT, '.kanban', 'audit.ndjson')
  const raw = await readFile(auditPath, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
async function findCardFile(cardId) {
  const dir = path.join(VAULT, 'kanban-data', PROJECT)
  const entries = await readdir(dir)
  for (const name of entries) {
    if (!name.endsWith('.md') || name.startsWith('_')) continue
    const full = path.join(dir, name)
    const content = await readFile(full, 'utf8')
    if (content.includes(`id: ${cardId}`)) return full
  }
  throw new Error(`card file for id=${cardId} not found in ${dir}`)
}

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const tok = extractRawToken((await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:alice',
  ])).stdout)
  const auth = { authorization: `Bearer ${tok}` }
  const tokens = { input_tokens: 0, output_tokens: 0, model: 'sprint04' }

  console.log('=== Scenario A: external mutation while MCP live ===')
  let mcp = startMcp()
  await waitReady(mcp)
  try {
    const created = await callTool(
      'kanban_create_card',
      { title: 'sync target', type: 'task', status: 'backlog', ...tokens },
      auth,
    )
    assert(created.status === 200, 'card created (status 200)')
    const cardId = created.body.id
    const v1 = created.body.version
    assert(v1 === 1, `initial version=1 (got ${v1})`)

    const file = await findCardFile(cardId)
    const before = await readFile(file, 'utf8')
    // Bump the title by hand — mimics a sync tool overwriting the file
    // with a stale-but-valid copy that has different content.
    const mutated = before.replace(/^title: .*/m, 'title: sync overwrite')
    assert(mutated !== before, 'mutation actually changed file content')

    const startCount = (await readAudit()).length
    const startTs = Date.now()
    await writeFile(file, mutated, 'utf8')

    // Debounce is 500ms; allow ~800ms for the watcher to debounce + process.
    let humanEdit = null
    for (let i = 0; i < 20; i++) {
      await sleep(100)
      const entries = await readAudit()
      humanEdit = entries.slice(startCount).find(
        (e) => e.op === 'HUMAN_EDIT' && e.card_id === cardId,
      )
      if (humanEdit) break
    }
    const elapsed = Date.now() - startTs
    assert(humanEdit, `HUMAN_EDIT logged for ${cardId} (elapsed=${elapsed}ms)`)
    assert(humanEdit.version === v1 + 1, `audit version bumped to ${v1 + 1} (got ${humanEdit.version})`)
    assert(elapsed < 1500, `detection within 1500ms (got ${elapsed}ms; debounce=500ms)`)

    console.log('=== Scenario A.2: agent stale-version update → 409 ===')
    const stale = await callTool(
      'kanban_update_card',
      { id: cardId, version: v1, title: 'agent racing', ...tokens },
      auth,
    )
    assert(stale.status === 409, `stale update → 409 (got ${stale.status})`)
    assert(stale.body.error === 'conflict', `error=conflict (got ${stale.body.error})`)
    assert(
      stale.body.current_card && stale.body.current_card.version === v1 + 1,
      `current_card.version=${v1 + 1} (got ${stale.body.current_card?.version})`,
    )
  } finally {
    await stopMcp(mcp)
  }

  console.log('=== Scenario B: offline mutation → RECONCILED on restart ===')
  // We reuse the same vault and find a card already on disk.
  const existing = (await readdir(path.join(VAULT, 'kanban-data', PROJECT)))
    .filter((n) => n.endsWith('.md') && !n.startsWith('_'))
  assert(existing.length >= 1, 'at least one .md present for offline scenario')
  const targetPath = path.join(VAULT, 'kanban-data', PROJECT, existing[0])
  const before = await readFile(targetPath, 'utf8')
  const offlineMutation = before.replace(/^title: .*/m, 'title: offline edit')
  assert(offlineMutation !== before, 'offline mutation actually changed content')
  await writeFile(targetPath, offlineMutation, 'utf8')

  const beforeAudit = await readAudit()
  const beforeCount = beforeAudit.length

  mcp = startMcp()
  await waitReady(mcp)
  try {
    // Reconciliation runs synchronously during startup; ready means done.
    const afterAudit = await readAudit()
    const reconciled = afterAudit.slice(beforeCount).filter((e) => e.op === 'RECONCILED')
    assert(reconciled.length >= 1, `RECONCILED logged on restart (got ${reconciled.length})`)
  } finally {
    await stopMcp(mcp)
  }

  console.log('\n✅ Sprint 04 TASK-33 external sync smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
