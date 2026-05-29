#!/usr/bin/env node
// Card-assignment enforcement smoke. Covers ownership gates on every
// mutation, the claim / release sugar tools, the cross-agent reassign
// restriction, audit CLAIM / RELEASE ops, and manager bypass.

import { rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-assignment'
const PORT = 13988
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'team'
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

const TOK = { input_tokens: 0, output_tokens: 0, model: 'smoke' }

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const mgrTok = extractRawToken((await runCli([
    'create', '--role', 'manager', '--actor', 'admin:me',
  ])).stdout)
  const aliceTok = extractRawToken((await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:alice',
  ])).stdout)
  const bobTok = extractRawToken((await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:bob',
  ])).stdout)

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Assignment enforcement smoke ===')

    // Bootstrap: alice creates an unassigned card
    const c0 = await call('kanban_create_card',
      { title: 'shared work', type: 'task', ...TOK }, aliceTok)
    check('bootstrap create → 200', c0.status === 200, `status=${c0.status}`)
    const id = c0.body.id
    let v = c0.body.version
    check('card starts unassigned', c0.body.assigned_to === null,
      `assigned_to=${c0.body.assigned_to}`)

    // ── claim ──────────────────────────────────────────────────
    const claim1 = await call('kanban_claim_card',
      { id, version: v, ...TOK }, aliceTok)
    check('alice claims unassigned → 200', claim1.status === 200, `status=${claim1.status}`)
    check('card now owned by alice',
      claim1.body.assigned_to === 'agent:alice',
      `assigned_to=${claim1.body.assigned_to}`)
    check('claim bumps version',
      claim1.body.version === v + 1, `${v}→${claim1.body.version}`)
    v = claim1.body.version

    // bob tries to claim → 409 already_claimed
    const claim2 = await call('kanban_claim_card',
      { id, version: v, ...TOK }, bobTok)
    check('bob claim already-owned → 409',
      claim2.status === 409 && claim2.body.error === 'already_claimed',
      `status=${claim2.status} error=${claim2.body?.error}`)
    check('409 surfaces current_assigned_to',
      claim2.body.current_assigned_to === 'agent:alice',
      `current=${claim2.body?.current_assigned_to}`)

    // alice claims her own card → idempotent no-version-bump path
    // Actually: it falls into applyAssignedTo path, but version check still
    // matches and assigned_to is already alice; let's just confirm she
    // can still call it without conflict.
    const claim3 = await call('kanban_claim_card',
      { id, version: v, ...TOK }, aliceTok)
    check('alice re-claims own card → 200', claim3.status === 200, `status=${claim3.status}`)
    v = claim3.body.version

    // ── ownership gate on mutations ────────────────────────────
    // bob tries to move alice's card → 403
    const moveBob = await call('kanban_move_card',
      { id, version: v, to_status: 'todo', ...TOK }, bobTok)
    check('bob move alice-owned → 403',
      moveBob.status === 403 && moveBob.body.reason === 'not_assigned',
      `status=${moveBob.status} reason=${moveBob.body?.reason}`)
    check('403 surfaces assigned_to in body',
      moveBob.body.assigned_to === 'agent:alice',
      `assigned_to=${moveBob.body?.assigned_to}`)

    // bob tries to update title → 403
    const updateBob = await call('kanban_update_card',
      { id, version: v, title: 'hijacked', ...TOK }, bobTok)
    check('bob update alice-owned → 403', updateBob.status === 403, `status=${updateBob.status}`)

    // bob tries to archive → 403
    const archiveBob = await call('kanban_archive_card',
      { id, version: v, ...TOK }, bobTok)
    check('bob archive alice-owned → 403', archiveBob.status === 403, `status=${archiveBob.status}`)

    // bob tries to delete → 403
    const delBob = await call('kanban_delete_card',
      { id, version: v, ...TOK }, bobTok)
    check('bob delete alice-owned → 403', delBob.status === 403, `status=${delBob.status}`)

    // alice can move her own card → 200
    const moveAlice = await call('kanban_move_card',
      { id, version: v, to_status: 'todo', ...TOK }, aliceTok)
    check('alice moves own card → 200', moveAlice.status === 200, `status=${moveAlice.status}`)
    v = moveAlice.body.version

    // ── cross-agent reassign ───────────────────────────────────
    // alice (agent) tries to reassign her card to bob → 403 cannot_reassign
    const reassignAgent = await call('kanban_update_card',
      { id, version: v, assigned_to: 'agent:bob', ...TOK }, aliceTok)
    check('agent reassign to other actor → 403',
      reassignAgent.status === 403 && reassignAgent.body.reason === 'cannot_reassign',
      `status=${reassignAgent.status} reason=${reassignAgent.body?.reason}`)

    // manager reassigns alice's card to bob → 200
    const reassignMgr = await call('kanban_update_card',
      { id, version: v, assigned_to: 'agent:bob', ...TOK }, mgrTok)
    check('manager reassign → 200', reassignMgr.status === 200, `status=${reassignMgr.status}`)
    check('manager reassign sets bob as owner',
      reassignMgr.body.assigned_to === 'agent:bob',
      `assigned_to=${reassignMgr.body?.assigned_to}`)
    v = reassignMgr.body.version

    // alice now blocked
    const aliceAfter = await call('kanban_update_card',
      { id, version: v, title: 'no way', ...TOK }, aliceTok)
    check('alice blocked after reassign to bob → 403',
      aliceAfter.status === 403, `status=${aliceAfter.status}`)

    // ── release ────────────────────────────────────────────────
    // alice can't release someone else's card
    const releaseAlice = await call('kanban_release_card',
      { id, version: v, ...TOK }, aliceTok)
    check('alice release bob-owned → 403',
      releaseAlice.status === 403, `status=${releaseAlice.status}`)

    // bob releases own card → 200
    const releaseBob = await call('kanban_release_card',
      { id, version: v, ...TOK }, bobTok)
    check('bob release own card → 200', releaseBob.status === 200, `status=${releaseBob.status}`)
    check('release sets assigned_to to null',
      releaseBob.body.assigned_to === null,
      `assigned_to=${releaseBob.body?.assigned_to}`)
    v = releaseBob.body.version

    // release no-op short circuit on already-null card
    const auditBefore = (await readAudit()).length
    const releaseNoop = await call('kanban_release_card',
      { id, version: v, ...TOK }, bobTok)
    const auditAfter = (await readAudit()).length
    check('release no-op keeps version',
      releaseNoop.status === 200 && releaseNoop.body.version === v,
      `v=${releaseNoop.body?.version} (want ${v})`)
    check('release no-op writes no audit row',
      auditBefore === auditAfter, `before=${auditBefore} after=${auditAfter}`)

    // After release, alice can claim again
    const claimAfter = await call('kanban_claim_card',
      { id, version: v, ...TOK }, aliceTok)
    check('alice re-claims after release → 200',
      claimAfter.status === 200, `status=${claimAfter.status}`)
    v = claimAfter.body.version

    // ── manager bypass on all mutations ────────────────────────
    const mgrMove = await call('kanban_move_card',
      { id, version: v, to_status: 'in-progress', ...TOK }, mgrTok)
    check('manager move alice-owned → 200',
      mgrMove.status === 200, `status=${mgrMove.status}`)
    v = mgrMove.body.version

    // ── manager claim-on-behalf ────────────────────────────────
    // release first
    const rel2 = await call('kanban_release_card', { id, version: v, ...TOK }, mgrTok)
    v = rel2.body.version
    const mgrClaim = await call('kanban_claim_card',
      { id, version: v, actor: 'agent:bob', ...TOK }, mgrTok)
    check('manager claim-on-behalf → 200',
      mgrClaim.status === 200, `status=${mgrClaim.status}`)
    check('manager claim sets target actor',
      mgrClaim.body.assigned_to === 'agent:bob',
      `assigned_to=${mgrClaim.body?.assigned_to}`)

    // ── audit ops ──────────────────────────────────────────────
    const audit = await readAudit()
    const ops = audit.filter((e) => e.card_id === id).map((e) => e.op)
    check('audit log records CLAIM',
      ops.includes('CLAIM'), `ops=${[...new Set(ops)].join(',')}`)
    check('audit log records RELEASE',
      ops.includes('RELEASE'), `ops=${[...new Set(ops)].join(',')}`)

  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} assignment check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Assignment smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
