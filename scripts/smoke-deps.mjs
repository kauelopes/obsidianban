#!/usr/bin/env node
// Dependencies smoke. Covers blocked_by validation (self-ref, missing card,
// cross-project, cycle), forward-move guard with 409 blocked, blocker
// satisfaction via done/archive/delete, and kanban_pick_next with sprint
// and assigned_to filters.

import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const VAULT = '/tmp/kanban-smoke-deps'
const PORT = 13988
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'depsproj'
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
async function getCard(id, tok) {
  const r = await call('kanban_get_card', { id }, tok)
  return r.body
}

const TOK = { input_tokens: 0, output_tokens: 0, model: 'smoke' }

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const mgr = extractRawToken(await runCli([
    'create', '--role', 'manager', '--actor', 'admin:me',
  ]))
  const agt = extractRawToken(await runCli([
    'create', '--project', PROJECT, '--role', 'agent', '--actor', 'agent:alice',
  ]))
  // Pre-seed an unrelated project for the cross-project blocker test
  const otherAgt = extractRawToken(await runCli([
    'create', '--project', 'otherproj', '--role', 'agent', '--actor', 'agent:eve',
  ]))

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Dependencies smoke ===')

    // Every card now needs a sprint. Mint one per project and attach all
    // creates to it so the dependency logic itself is what gets exercised.
    const sprint = (await call('kanban_create_sprint',
      { project: PROJECT, name: 'deps sprint', goal: 'test deps' }, mgr)).body
    const otherSprint = (await call('kanban_create_sprint',
      { project: 'otherproj', name: 'other sprint', goal: 'isolate' }, mgr)).body
    const SP = { sprint_id: sprint.id }
    const SP_OTHER = { sprint_id: otherSprint.id }

    // Bootstrap two cards in depsproj
    const a = (await call('kanban_create_card',
      { title: 'A', type: 'task', ...SP, ...TOK }, agt)).body
    const b = (await call('kanban_create_card',
      { title: 'B depends on A', type: 'task', ...SP, ...TOK }, agt)).body
    const otherCard = (await call('kanban_create_card',
      { title: 'cross', type: 'task', ...SP_OTHER, ...TOK }, otherAgt)).body

    // ── validation ────────────────────────────────────────────────
    // self-reference
    const selfRef = await call('kanban_update_card',
      { id: b.id, version: b.version, blocked_by: [b.id], ...TOK }, agt)
    check('self-reference rejected',
      selfRef.status === 400 && /itself/.test(selfRef.body.reason),
      `status=${selfRef.status} reason=${selfRef.body?.reason}`)

    // missing card
    const missing = await call('kanban_update_card',
      { id: b.id, version: b.version, blocked_by: ['card-DOESNOT'], ...TOK }, agt)
    check('missing card rejected',
      missing.status === 400 && /unknown card id/.test(missing.body.reason),
      `status=${missing.status}`)

    // cross-project
    const cross = await call('kanban_update_card',
      { id: b.id, version: b.version, blocked_by: [otherCard.id], ...TOK }, agt)
    check('cross-project blocker rejected',
      cross.status === 400 && /cross-project/.test(cross.body.reason),
      `status=${cross.status}`)

    // Valid: B blocked by A
    const ok = await call('kanban_update_card',
      { id: b.id, version: b.version, blocked_by: [a.id], ...TOK }, agt)
    check('valid blocked_by accepted → 200',
      ok.status === 200, `status=${ok.status}`)
    check('blocked_by reflected on card',
      JSON.stringify(ok.body.blocked_by) === JSON.stringify([a.id]),
      `blocked_by=${JSON.stringify(ok.body.blocked_by)}`)

    // ── create_card with blocked_by ───────────────────────────────
    const createBlocked = await call('kanban_create_card',
      { title: 'C depends on A', type: 'task', blocked_by: [a.id], ...SP, ...TOK }, agt)
    check('create with blocked_by → 200',
      createBlocked.status === 200, `status=${createBlocked.status}`)
    check('created card carries blocked_by from create',
      JSON.stringify(createBlocked.body.blocked_by) === JSON.stringify([a.id]),
      `blocked_by=${JSON.stringify(createBlocked.body.blocked_by)}`)

    const createBadBlocker = await call('kanban_create_card',
      { title: 'D bad', type: 'task', blocked_by: ['card-DOESNOT'], ...SP, ...TOK }, agt)
    check('create with unknown blocker rejected',
      createBadBlocker.status === 400
        && /unknown card id/.test(createBadBlocker.body.reason),
      `status=${createBadBlocker.status}`)

    // ── cycle detection ──────────────────────────────────────────
    const cycle = await call('kanban_update_card',
      { id: a.id, version: a.version, blocked_by: [b.id], ...TOK }, agt)
    check('cycle (A→B, B→A) rejected',
      cycle.status === 400 && /cycle/.test(cycle.body.reason),
      `status=${cycle.status} reason=${cycle.body?.reason}`)

    // ── move guard ───────────────────────────────────────────────
    // B is blocked → cannot advance past todo
    let bVersion = ok.body.version
    const movePastBlocked = await call('kanban_move_card',
      { id: b.id, version: bVersion, to_status: 'in-progress', ...TOK }, agt)
    check('move blocked card → 409 blocked',
      movePastBlocked.status === 409
        && movePastBlocked.body.error === 'blocked'
        && Array.isArray(movePastBlocked.body.blockers)
        && movePastBlocked.body.blockers[0].id === a.id,
      `status=${movePastBlocked.status} err=${movePastBlocked.body?.error}`)

    // Move to todo is still allowed (sideways within unstarted columns)
    const moveToTodo = await call('kanban_move_card',
      { id: b.id, version: bVersion, to_status: 'todo', ...TOK }, agt)
    check('move blocked card to todo allowed',
      moveToTodo.status === 200, `status=${moveToTodo.status}`)
    bVersion = moveToTodo.body.version

    // update_card with status change also blocked
    const updStatus = await call('kanban_update_card',
      { id: b.id, version: bVersion, status: 'in-progress', ...TOK }, agt)
    check('update_card advancing blocked → 409 blocked',
      updStatus.status === 409 && updStatus.body.error === 'blocked',
      `status=${updStatus.status} err=${updStatus.body?.error}`)

    // ── satisfaction via done ────────────────────────────────────
    let aRow = await getCard(a.id, agt)
    aRow = (await call('kanban_move_card',
      { id: a.id, version: aRow.version, to_status: 'in-progress', ...TOK }, agt)).body
    aRow = (await call('kanban_move_card',
      { id: a.id, version: aRow.version, to_status: 'done', ...TOK }, agt)).body
    check('A advanced to done', aRow.status === 'done', `status=${aRow.status}`)

    const moveAfterDone = await call('kanban_move_card',
      { id: b.id, version: bVersion, to_status: 'in-progress', ...TOK }, agt)
    check('blocked card advances once blocker done',
      moveAfterDone.status === 200, `status=${moveAfterDone.status}`)
    bVersion = moveAfterDone.body.version

    // ── satisfaction via archive (reset state) ───────────────────
    // Move B back to backlog, archive A, B should now be able to advance
    const bReset = await call('kanban_move_card',
      { id: b.id, version: bVersion, to_status: 'backlog', ...TOK }, agt)
    bVersion = bReset.body.version
    // Re-establish blocker
    const bBlock = await call('kanban_update_card',
      { id: b.id, version: bVersion, blocked_by: [a.id], ...TOK }, agt)
    bVersion = bBlock.body.version
    // Move A back to in-progress (not done) so blocker is unsatisfied
    aRow = await getCard(a.id, agt)
    aRow = (await call('kanban_move_card',
      { id: a.id, version: aRow.version, to_status: 'in-progress', ...TOK }, agt)).body
    // Confirm blocked
    const blockedAgain = await call('kanban_move_card',
      { id: b.id, version: bVersion, to_status: 'in-progress', ...TOK }, agt)
    check('blocker reset (A back to in-progress) re-blocks B',
      blockedAgain.status === 409, `status=${blockedAgain.status}`)
    // Archive A
    aRow = await getCard(a.id, agt)
    await call('kanban_archive_card',
      { id: a.id, version: aRow.version, ...TOK }, agt)
    const afterArchive = await call('kanban_move_card',
      { id: b.id, version: bVersion, to_status: 'in-progress', ...TOK }, agt)
    check('blocker satisfied via archive',
      afterArchive.status === 200, `status=${afterArchive.status}`)
    bVersion = afterArchive.body.version

    // ── pick_next ────────────────────────────────────────────────
    // Reset: create three fresh todo cards, two blocked, one ready
    const ready = (await call('kanban_create_card',
      { title: 'ready', type: 'task', priority: 'high', ...SP, ...TOK }, agt)).body
    const blocker = (await call('kanban_create_card',
      { title: 'blocker', type: 'task', ...SP, ...TOK }, agt)).body
    const blocked = (await call('kanban_create_card',
      { title: 'blocked', type: 'task', priority: 'critical', ...SP, ...TOK }, agt)).body
    await call('kanban_update_card',
      { id: blocked.id, version: blocked.version, blocked_by: [blocker.id], ...TOK }, agt)

    // Move all three to todo
    await call('kanban_move_card', { id: ready.id, version: 1, to_status: 'todo', ...TOK }, agt)
    await call('kanban_move_card', { id: blocker.id, version: 1, to_status: 'todo', ...TOK }, agt)
    await call('kanban_move_card', { id: blocked.id, version: 2, to_status: 'todo', ...TOK }, agt)

    // pick_next: should pick blocker (priority medium) or ready (priority high)?
    // The order_by priority sorts critical → high → medium → low. blocked is
    // critical but blocked, ready is high, blocker is medium. So:
    //   1. blocked (critical) — but unsatisfied → skip, blocked_candidates++
    //   2. ready (high) — return
    const pick1 = await call('kanban_pick_next', {}, agt)
    check('pick_next skips blocked and returns first ready by priority',
      pick1.body.card?.id === ready.id
        && pick1.body.blocked_candidates === 1,
      `card=${pick1.body.card?.id} blocked=${pick1.body.blocked_candidates}`)

    // Move blocker to done — now critical card is ready
    let blockerV = (await getCard(blocker.id, agt)).version
    await call('kanban_move_card',
      { id: blocker.id, version: blockerV, to_status: 'in-progress', ...TOK }, agt)
    blockerV = (await getCard(blocker.id, agt)).version
    await call('kanban_move_card',
      { id: blocker.id, version: blockerV, to_status: 'done', ...TOK }, agt)
    const pick2 = await call('kanban_pick_next', {}, agt)
    check('pick_next now picks the critical card (previously blocked)',
      pick2.body.card?.id === blocked.id,
      `card=${pick2.body.card?.id}`)

    // pick_next with assigned_to filter — no match, returns null
    const pick3 = await call('kanban_pick_next', { assigned_to: 'agent:nobody' }, agt)
    check('pick_next with no match returns null',
      pick3.body.card === null,
      `card=${pick3.body.card}`)

    // pick_next with sprint filter — no sprint set on any card, returns null
    const pick4 = await call('kanban_pick_next', { sprint_id: 'sprint-NONE' }, agt)
    check('pick_next sprint filter with no members returns null',
      pick4.body.card === null,
      `card=${pick4.body.card}`)

  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} deps check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Dependencies smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
