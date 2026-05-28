#!/usr/bin/env node
// Project archive / unarchive / delete smoke. Covers role gate,
// list_projects filter precedence, the cascade hide in list_cards for
// managers fetching the whole board, the confirm guard on delete, and SSE
// PROJECT_* broadcasts.

import { rm, stat, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-project-menu'
const PORT = 13944
const BASE = `http://127.0.0.1:${PORT}`
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
    let stdout = ''; let stderr = ''
    c.stdout.on('data', (d) => (stdout += d.toString()))
    c.stderr.on('data', (d) => (stderr += d.toString()))
    c.on('exit', (code) => resolve({ code, stdout, stderr }))
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
async function readAudit() {
  const raw = await readFile(path.join(VAULT, '.kanban', 'audit.ndjson'), 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function collectSse(matchType, project, windowMs) {
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
          const type = eventLine.slice(6).trim()
          if (type !== matchType) continue
          try {
            const payload = JSON.parse(dataLine.slice(5).trim())
            if (payload?.project === project) events.push({ type, payload })
          } catch {}
        }
      })
      res.on('end', () => { clearTimeout(timer); resolve(events) })
    })
    req.on('error', () => resolve(events))
    req.end()
  })
}

const TOK = { input_tokens: 0, output_tokens: 0, model: 'smoke' }

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const mgrTok = extractRawToken((await runCli([
    'create', '--role', 'manager', '--actor', 'admin:me',
  ])).stdout)
  const agentTok = extractRawToken((await runCli([
    'create', '--project', 'agentown', '--role', 'agent', '--actor', 'agent:bob',
  ])).stdout)

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Project menu smoke ===')

    // Bootstrap: create two projects so we can archive one and keep the
    // other visible.
    const projA = await call('kanban_create_project',
      { project: 'alpha', actor: 'agent:alice' }, mgrTok)
    const projB = await call('kanban_create_project',
      { project: 'beta', actor: 'agent:betty' }, mgrTok)
    check('bootstrap alpha created', projA.status === 200, `status=${projA.status}`)
    check('bootstrap beta created', projB.status === 200, `status=${projB.status}`)

    // ── archive ────────────────────────────────────────────────
    // Agent forbidden
    const r1 = await call('kanban_archive_project', { project: 'alpha' }, agentTok)
    check('agent cannot archive → 403', r1.status === 403, `status=${r1.status}`)

    // SSE while archiving
    const ssePromise = collectSse('PROJECT_ARCHIVED', 'alpha', 1500)
    await sleep(100)
    const r2 = await call('kanban_archive_project', { project: 'alpha' }, mgrTok)
    check('manager archive → 200', r2.status === 200, `status=${r2.status}`)
    check('archive returns archived=true',
      r2.body.archived === true, `archived=${r2.body.archived}`)
    const sseHits = await ssePromise
    check('PROJECT_ARCHIVED SSE emitted',
      sseHits.length === 1, `n=${sseHits.length}`)

    // list_projects default hides alpha (agentown and beta are active)
    const lp1 = await call('kanban_list_projects', {}, mgrTok)
    const visible = (lp1.body.projects ?? []).map((p) => p.project).sort()
    check('default list_projects hides alpha',
      !visible.includes('alpha') && visible.includes('beta'),
      `visible=${visible.join(',')}`)

    // include_archived=true brings it back, with archived flag set
    const lp2 = await call('kanban_list_projects', { include_archived: true }, mgrTok)
    const alphaEntry = (lp2.body.projects ?? []).find((p) => p.project === 'alpha')
    check('include_archived returns alpha with archived=true',
      alphaEntry?.archived === true, `archived=${alphaEntry?.archived}`)

    // archived_only=true returns only alpha
    const lp3 = await call('kanban_list_projects', { archived_only: true }, mgrTok)
    check('archived_only returns only alpha',
      lp3.body.projects?.length === 1 && lp3.body.projects[0].project === 'alpha',
      `n=${lp3.body.projects?.length}`)

    // list_cards cascades: cards in alpha disappear for manager full-board
    const lcAll = await call('kanban_list_cards', {}, mgrTok)
    const alphaCardsHidden = !(lcAll.body.cards ?? []).some((c) => c.project === 'alpha')
    check('manager full-board list_cards hides alpha cards',
      alphaCardsHidden, `cards=${lcAll.body.cards.length}`)

    // include_archived_projects=true brings them back
    const lcAllProjs = await call('kanban_list_cards',
      { include_archived_projects: true }, mgrTok)
    const alphaCardsBack = (lcAllProjs.body.cards ?? []).some((c) => c.project === 'alpha')
    check('include_archived_projects=true brings alpha cards back',
      alphaCardsBack, `cards=${lcAllProjs.body.cards.length}`)

    // Explicit project filter also bypasses the cascade
    const lcAlpha = await call('kanban_list_cards', { project: 'alpha' }, mgrTok)
    check('explicit project=alpha returns its cards',
      (lcAlpha.body.cards ?? []).length > 0,
      `cards=${lcAlpha.body.cards?.length}`)

    // ── unarchive ──────────────────────────────────────────────
    const r3 = await call('kanban_unarchive_project', { project: 'alpha' }, mgrTok)
    check('unarchive → 200', r3.status === 200, `status=${r3.status}`)
    check('unarchive returns archived=false',
      r3.body.archived === false, `archived=${r3.body.archived}`)

    // No-op short-circuit on already-unarchived
    const auditBefore = (await readAudit()).length
    const r4 = await call('kanban_unarchive_project', { project: 'alpha' }, mgrTok)
    const auditAfter = (await readAudit()).length
    check('unarchive no-op writes no audit row',
      r4.status === 200 && auditBefore === auditAfter,
      `before=${auditBefore} after=${auditAfter}`)

    // ── delete ─────────────────────────────────────────────────
    // Missing confirm
    const r5 = await call('kanban_delete_project',
      { project: 'alpha' }, mgrTok)
    check('delete without confirm → 400',
      r5.status === 400 && r5.body.field === 'confirm',
      `status=${r5.status} field=${r5.body?.field}`)

    // Wrong confirm
    const r6 = await call('kanban_delete_project',
      { project: 'alpha', confirm: 'wrong' }, mgrTok)
    check('delete with wrong confirm → 400',
      r6.status === 400 && r6.body.field === 'confirm',
      `status=${r6.status} field=${r6.body?.field}`)

    // Agent forbidden
    const r7 = await call('kanban_delete_project',
      { project: 'alpha', confirm: 'alpha' }, agentTok)
    check('agent cannot delete → 403', r7.status === 403, `status=${r7.status}`)

    // Manager happy path
    const ssePromise2 = collectSse('PROJECT_DELETED', 'alpha', 1500)
    await sleep(100)
    const r8 = await call('kanban_delete_project',
      { project: 'alpha', confirm: 'alpha' }, mgrTok)
    check('manager delete → 200', r8.status === 200, `status=${r8.status}`)
    check('delete reports cards_deleted',
      typeof r8.body.cards_deleted === 'number' && r8.body.cards_deleted >= 1,
      `cards_deleted=${r8.body.cards_deleted}`)
    const sseHits2 = await ssePromise2
    check('PROJECT_DELETED SSE emitted',
      sseHits2.length === 1, `n=${sseHits2.length}`)

    // Folder gone
    const st = await stat(path.join(VAULT, 'kanban-data', 'alpha')).catch(() => null)
    check('project folder removed', st === null, `exists=${st !== null}`)

    // No cards remain in DB
    const lcAfter = await call('kanban_list_cards',
      { project: 'alpha', include_archived: true, include_archived_projects: true },
      mgrTok)
    check('no alpha cards remain after delete',
      (lcAfter.body.cards ?? []).length === 0,
      `n=${lcAfter.body.cards?.length}`)

    // list_projects no longer returns alpha
    const lpAfter = await call('kanban_list_projects',
      { include_archived: true }, mgrTok)
    const stillThere = (lpAfter.body.projects ?? []).some((p) => p.project === 'alpha')
    check('list_projects no longer returns alpha',
      !stillThere, `stillThere=${stillThere}`)

  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} project-menu check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Project menu smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
