#!/usr/bin/env node
// End-to-end smoke for Sprint 01 batch 2 (TASK-03/04/05).
// Drives the MCP server as a subprocess and asserts atomicity, hash
// integrity, immutable-field revert, and orphan removal.
import { mkdir, rm, readFile, writeFile, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'

const VAULT = '/tmp/kanban-smoke-batch2'
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let mcpCounter = 0
function startMcp() {
  const tag = `mcp${++mcpCounter}`
  const child = spawn('node_modules/.bin/tsx', ['src/index.ts'], {
    env: { ...process.env, VAULT_PATH: VAULT },
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
  await Promise.race([
    exited,
    sleep(2000).then(() => {
      try { child.kill('SIGKILL') } catch {}
    }),
  ])
}

async function waitReady(child, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('startup timeout')), timeoutMs)
    const onData = (d) => {
      if (d.toString().includes('ready')) {
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

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  await mkdir(path.join(VAULT, '.kanban-data', 'demo'), { recursive: true })
  await writeFile(
    path.join(VAULT, '.kanban-data', 'demo', '_meta.json'),
    JSON.stringify({
      project_id: 'demo',
      columns: ['backlog', 'in-progress', 'done'],
      agent_tokens: [],
      created_at: new Date().toISOString(),
    }),
  )

  console.log('=== Test 1: AtomicWriter writes .md + SQLite atomically ===')
  process.env.VAULT_PATH = VAULT
  const { loadConfig } = await import(path.resolve('src/config.ts'))
  const { ensureLayout } = await import(path.resolve('src/vault/layout.ts'))
  const { openDatabase } = await import(path.resolve('src/db/database.ts'))
  const { CardRepository } = await import(path.resolve('src/cards/repository.ts'))
  const { AtomicWriter } = await import(path.resolve('src/writer/atomic.ts'))
  const cfg = loadConfig()
  await ensureLayout(cfg.paths)
  const { db } = await openDatabase(cfg.paths.sqlite)
  const repo = new CardRepository(db)
  const writer = new AtomicWriter(cfg.paths, repo)

  const now = new Date().toISOString()
  const card = {
    id: 'card-abcd1234',
    project: 'demo',
    title: 'Hello',
    status: 'backlog',
    type: 'task',
    version: 1,
    position: 0,
    priority: 'medium',
    tags: ['x', 'y'],
    due_date: null,
    assigned_to: null,
    owner: null,
    agent_notes: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    created_at: now,
    updated_at: now,
    created_by: 'agent:t',
    updated_by: 'agent:t',
  }
  const { fileHash } = await writer.write(card, 'body text\n')
  const mdPath = path.join(VAULT, '.kanban-data', 'demo', 'card-abcd1234.md')
  const content = await readFile(mdPath, 'utf8')
  assert(content.startsWith('---'), 'frontmatter present')
  assert(content.includes('id: card-abcd1234'), 'id in frontmatter')
  assert(sha(content) === fileHash, 'file_hash matches SHA-256 of file content')
  const row = repo.findById('card-abcd1234')
  assert(row !== null && row.file_hash === fileHash, 'SQLite row has matching file_hash')
  db.close()

  console.log('=== Test 2: reconciliation rebuilds SQLite from .md ===')
  await unlink(path.join(VAULT, '.kanban', 'db.sqlite'))
  const mcp2 = startMcp()
  await waitReady(mcp2)
  await stopMcp(mcp2)
  const db2 = new Database(path.join(VAULT, '.kanban', 'db.sqlite'))
  const rebuilt = db2.prepare('SELECT id, title FROM cards').all()
  assert(rebuilt.length === 1 && rebuilt[0].id === 'card-abcd1234', 'card recovered from .md')
  db2.close()

  console.log('=== Test 3: watcher reverts immutable field (id) ===')
  const mcp3 = startMcp()
  await waitReady(mcp3)
  const md = await readFile(mdPath, 'utf8')
  await writeFile(mdPath, md.replace('id: card-abcd1234', 'id: card-EVILEVIL'))
  await sleep(2000)
  const restored = await readFile(mdPath, 'utf8')
  assert(restored.includes('id: card-abcd1234'), 'id reverted to original')
  await stopMcp(mcp3)

  console.log('=== Test 4: orphan removal ===')
  await unlink(mdPath)
  const mcp4 = startMcp()
  await waitReady(mcp4)
  await stopMcp(mcp4)
  const db4 = new Database(path.join(VAULT, '.kanban', 'db.sqlite'))
  const left = db4.prepare('SELECT COUNT(*) c FROM cards').get()
  assert(left.c === 0, 'orphan row removed')
  db4.close()

  const auditOps = (await readFile(path.join(VAULT, '.kanban', 'audit.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).op)
  for (const op of ['SQLITE_REBUILT', 'RECONCILED', 'FIELD_REVERTED', 'HUMAN_EDIT', 'ORPHAN_REMOVED']) {
    assert(auditOps.includes(op), `${op} logged`)
  }

  console.log('\nALL TESTS PASSED')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
