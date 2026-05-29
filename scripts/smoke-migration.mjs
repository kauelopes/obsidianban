#!/usr/bin/env node
// Migration smoke for the sprint+deps release. Stages a vault that looks
// like the pre-release state — a SQLite without sprint_id / blocked_by
// columns, a _meta.json without `sprints`, and a card .md whose
// frontmatter pre-dates the new fields — then boots the MCP and verifies
// the columns get added, defaults populated, the legacy card survives,
// and subsequent writes propagate the new fields onto disk.

import { rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-migration'
const PORT = 13955
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'legacyproj'
const CARD_ID = 'card-LEGACY01'
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

// ── Pre-release state builder ──────────────────────────────────────────

// Frontmatter values that look like ISO timestamps must stay quoted so
// js-yaml (under gray-matter) hands them back as strings, not Date objects
// — the parser cares because requireStr() refuses non-strings.
const LEGACY_MD = `---
id: '${CARD_ID}'
project: '${PROJECT}'
title: legacy card
status: backlog
type: task
version: 1
position: 1000
priority: medium
tags: []
due_date: null
assigned_to: null
owner: null
agent_notes: null
total_input_tokens: 0
total_output_tokens: 0
archived: false
created_at: '2025-01-01T00:00:00.000Z'
updated_at: '2025-01-01T00:00:00.000Z'
created_by: 'agent:legacy'
updated_by: 'agent:legacy'
---

Pre-release card body.
`

const LEGACY_META = {
  project_id: PROJECT,
  columns: ['backlog', 'todo', 'in-progress', 'review', 'done'],
  agent_tokens: [],
  created_at: '2025-01-01T00:00:00.000Z',
  // intentionally no `sprints`, no `archived`
}

async function stagePreReleaseVault() {
  await rm(VAULT, { recursive: true, force: true })
  await mkdir(path.join(VAULT, '.kanban'), { recursive: true })
  await mkdir(path.join(VAULT, 'kanban-data', PROJECT), { recursive: true })

  // Legacy SQLite: schema WITHOUT sprint_id / blocked_by columns. Mirrors
  // what a vault from before this release would look like on disk.
  const sqlitePath = path.join(VAULT, '.kanban', 'db.sqlite')
  const db = new Database(sqlitePath)
  // Stay on the default journal_mode (delete) for staging — by the time we
  // close, every byte sits in the main .db file so MCP sees the legacy row
  // immediately. (Opening in WAL here without checkpointing would leak
  // committed pages into .db-wal and confuse the next opener.)
  db.exec(`
    CREATE TABLE cards (
      id                   TEXT PRIMARY KEY,
      project              TEXT NOT NULL,
      title                TEXT NOT NULL,
      status               TEXT NOT NULL,
      type                 TEXT NOT NULL,
      version              INTEGER NOT NULL,
      position             INTEGER NOT NULL,
      priority             TEXT NOT NULL DEFAULT 'medium',
      tags                 TEXT NOT NULL DEFAULT '[]',
      due_date             TEXT,
      assigned_to          TEXT,
      owner                TEXT,
      agent_notes          TEXT,
      total_input_tokens   INTEGER NOT NULL DEFAULT 0,
      total_output_tokens  INTEGER NOT NULL DEFAULT 0,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      created_by           TEXT NOT NULL,
      updated_by           TEXT NOT NULL,
      file_hash            TEXT NOT NULL,
      file_basename        TEXT NOT NULL DEFAULT '',
      archived             INTEGER NOT NULL DEFAULT 0
      /* intentionally no sprint_id, no blocked_by */
    )
  `)
  db.exec(`CREATE INDEX idx_project_status ON cards(project, status)`)
  db.exec(`CREATE INDEX idx_project_basename ON cards(project, file_basename)`)
  db.exec(`CREATE INDEX idx_project_archived ON cards(project, archived)`)

  const fileHash = createHash('sha256').update(LEGACY_MD, 'utf8').digest('hex')
  db.prepare(`
    INSERT INTO cards (
      id, project, title, status, type, version, position, priority, tags,
      due_date, assigned_to, owner, agent_notes,
      total_input_tokens, total_output_tokens,
      created_at, updated_at, created_by, updated_by,
      file_hash, file_basename, archived
    ) VALUES (
      @id, @project, @title, @status, @type, @version, @position, @priority, @tags,
      @due_date, @assigned_to, @owner, @agent_notes,
      @total_input_tokens, @total_output_tokens,
      @created_at, @updated_at, @created_by, @updated_by,
      @file_hash, @file_basename, @archived
    )
  `).run({
    id: CARD_ID, project: PROJECT, title: 'legacy card', status: 'backlog',
    type: 'task', version: 1, position: 1000, priority: 'medium', tags: '[]',
    due_date: null, assigned_to: null, owner: null, agent_notes: null,
    total_input_tokens: 0, total_output_tokens: 0,
    created_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z',
    created_by: 'agent:legacy', updated_by: 'agent:legacy',
    file_hash: fileHash, file_basename: CARD_ID, archived: 0,
  })
  db.close()

  // _meta.json without `sprints`
  await writeFile(
    path.join(VAULT, 'kanban-data', PROJECT, '_meta.json'),
    JSON.stringify(LEGACY_META, null, 2) + '\n',
    'utf8',
  )

  // The .md file matching what's recorded in SQLite
  await writeFile(
    path.join(VAULT, 'kanban-data', PROJECT, `${CARD_ID}.md`),
    LEGACY_MD,
    'utf8',
  )
}

function inspectMigratedSqlite() {
  const db = new Database(path.join(VAULT, '.kanban', 'db.sqlite'), { readonly: true })
  try {
    const cols = db.prepare(`PRAGMA table_info(cards)`).all()
    const row = db.prepare(`SELECT * FROM cards WHERE id = ?`).get(CARD_ID)
    return { cols, row }
  } finally {
    db.close()
  }
}

async function main() {
  console.log('=== Migration smoke (pre-release vault → current schema) ===')
  await stagePreReleaseVault()
  check('pre-release SQLite + _meta + .md staged on disk', true)

  // Mint a token AFTER the schema is in place so we don't perturb _meta.json
  // before our setup is verified. CLI uses loadProjectMeta which reads the
  // legacy structure without complaint (sprints? is optional).
  const tok = extractRawToken(await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:probe',
  ]))

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    // ── 1. Schema migration ran ───────────────────────────────────
    const before = inspectMigratedSqlite()
    const colNames = before.cols.map((c) => c.name)
    check('sprint_id column added by migration',
      colNames.includes('sprint_id'),
      `cols=${colNames.join(',')}`)
    check('blocked_by column added by migration',
      colNames.includes('blocked_by'))
    check('legacy card row preserved (not wiped)', before.row != null,
      `id=${before.row?.id}`)
    check('legacy row gets sprint_id NULL via DEFAULT',
      before.row.sprint_id === null,
      `sprint_id=${before.row.sprint_id}`)
    check('legacy row gets blocked_by "[]" via DEFAULT',
      before.row.blocked_by === '[]',
      `blocked_by=${before.row.blocked_by}`)

    // ── 2. HTTP layer reads the migrated row cleanly ──────────────
    const lc = await call('kanban_list_cards', {}, tok)
    check('list_cards returns the legacy card → 200',
      lc.status === 200 && lc.body.cards?.length === 1,
      `n=${lc.body.cards?.length}`)
    const card = lc.body.cards[0]
    check('card surfaces sprint_id: null',
      card.sprint_id === null,
      `sprint_id=${card.sprint_id}`)
    check('card surfaces blocked_by: []',
      Array.isArray(card.blocked_by) && card.blocked_by.length === 0,
      `blocked_by=${JSON.stringify(card.blocked_by)}`)

    // ── 3. get_card includes new fields without losing legacy ones ─
    const get = await call('kanban_get_card', { id: CARD_ID }, tok)
    check('get_card → 200', get.status === 200, `status=${get.status}`)
    check('get_card preserves legacy title',
      get.body.title === 'legacy card', `title=${get.body.title}`)
    check('get_card body preserved through migration',
      typeof get.body.body === 'string' && get.body.body.includes('Pre-release'),
      `body.snippet=${get.body.body?.slice(0,40)}`)

    // ── 4. Update writes new fields to disk ───────────────────────
    const upd = await call('kanban_update_card', {
      id: CARD_ID,
      version: get.body.version,
      title: 'legacy card (touched)',
      input_tokens: 0, output_tokens: 0, model: 'migration-smoke',
    }, tok)
    check('update legacy card succeeds → 200',
      upd.status === 200, `status=${upd.status}`)

    // The writer slugifies the new title, so the .md file basename may have
    // changed. Trust the response, not the legacy filename.
    const newBasename = upd.body?.file_basename ?? CARD_ID
    const mdPath = path.join(VAULT, 'kanban-data', PROJECT, `${newBasename}.md`)
    const mdAfter = await readFile(mdPath, 'utf8')
    check('post-update .md frontmatter now contains sprint_id',
      /^sprint_id:/m.test(mdAfter),
      `present=${/^sprint_id:/m.test(mdAfter)}`)
    check('post-update .md frontmatter now contains blocked_by',
      /^blocked_by:/m.test(mdAfter),
      `present=${/^blocked_by:/m.test(mdAfter)}`)

    // ── 5. _meta.json without `sprints` accepted by list_sprints ──
    // Use an agent token — agents are scoped, so we test the most-common
    // legacy code path (no `sprints` field present yet).
    const ls = await call('kanban_list_sprints', {}, tok)
    check('list_sprints over legacy meta → 200 with empty list',
      ls.status === 200 && Array.isArray(ls.body.sprints) && ls.body.sprints.length === 0,
      `n=${ls.body.sprints?.length}`)

    // ── 6. Adding the first sprint upgrades the meta in place ─────
    const mgr = extractRawToken(await runCli([
      'create', '--role', 'manager', '--actor', 'admin:probe',
    ]))
    const cs = await call('kanban_create_sprint',
      { project: PROJECT, name: 'first', goal: 'shake out migration' }, mgr)
    check('create_sprint on legacy project → 200',
      cs.status === 200, `status=${cs.status}`)
    const metaPath = path.join(VAULT, 'kanban-data', PROJECT, '_meta.json')
    const metaAfter = JSON.parse(await readFile(metaPath, 'utf8'))
    check('_meta.json grew a sprints array after first create_sprint',
      Array.isArray(metaAfter.sprints) && metaAfter.sprints.length === 1,
      `sprints=${metaAfter.sprints?.length}`)
    check('legacy meta keys preserved (project_id, columns, agent_tokens)',
      metaAfter.project_id === PROJECT
        && Array.isArray(metaAfter.columns)
        && Array.isArray(metaAfter.agent_tokens),
      `project_id=${metaAfter.project_id}`)
  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} migration check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Migration smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
