#!/usr/bin/env node
// Long-running jobs smoke. Covers the kanban_*_job round trip: start (card
// parked on job:<id>, kept in_progress), get_job running → succeeded,
// hand-back to todo with a result log on finalize, and list_jobs filtering.

import { rm, mkdir, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-jobs'
const REPO = '/tmp/kanban-smoke-jobs-repo'
const PORT = 13993
const BASE = `http://127.0.0.1:${PORT}`
const PROJECT = 'jobsproj'
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

const TOK = { input_tokens: 0, output_tokens: 0, model: 'smoke' }

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  await rm(REPO, { recursive: true, force: true })
  await mkdir(REPO, { recursive: true })

  const mgrTok = extractRawToken(await runCli([
    'create', '--role', 'manager', '--actor', 'admin:me',
  ]))

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Long-running jobs smoke ===')

    // ── bootstrap: project (with target_repo) + sprint + card ─────
    const proj = await call('kanban_create_project',
      { project: PROJECT, actor: 'agent:dev', target_repo: REPO }, mgrTok)
    check('create project with target_repo → 200', proj.status === 200, `status=${proj.status}`)
    const devTok = proj.body.token

    const sprint = await call('kanban_create_sprint',
      { project: PROJECT, name: 'Sprint J', goal: 'jobs smoke' }, mgrTok)
    check('create sprint → 200', sprint.status === 200, `status=${sprint.status}`)
    const sprintId = sprint.body.id

    const started = await call('kanban_start_sprint', { sprint_id: sprintId }, mgrTok)
    check('start sprint → 200', started.status === 200, `status=${started.status}`)

    const c0 = await call('kanban_create_card',
      { title: 'run a job', type: 'task', sprint_id: sprintId, ...TOK }, devTok)
    check('create card → 200', c0.status === 200, `status=${c0.status}`)
    const cardId = c0.body.id
    let v = c0.body.version

    const claim = await call('kanban_claim_card', { id: cardId, version: v }, devTok)
    check('claim card → 200', claim.status === 200, `status=${claim.status}`)
    v = claim.body.version

    // ── start_job ───────────────────────────────────────────────
    const start = await call('kanban_start_job',
      { id: cardId, version: v, command: 'sleep 2 && echo done', description: 'smoke job' }, devTok)
    check('start_job → 200', start.status === 200, `status=${start.status}`)
    check('start_job returns running JobView',
      start.body?.status === 'running' && typeof start.body?.job_id === 'string',
      `status=${start.body?.status} job_id=${start.body?.job_id}`)
    const jobId = start.body.job_id

    // Card parked on the job, still (or now) in_progress.
    const c1 = await call('kanban_get_card', { id: cardId }, devTok)
    check('card assigned_to job:<id> while running',
      c1.body.assigned_to === `job:${jobId}`, `assigned_to=${c1.body.assigned_to}`)
    check('card kept in_progress while running',
      c1.body.status === 'in_progress', `status=${c1.body.status}`)

    // ── get_job: running ────────────────────────────────────────
    const running = await call('kanban_get_job', { job_id: jobId }, devTok)
    check('get_job → 200', running.status === 200, `status=${running.status}`)
    check('get_job reports running',
      running.body?.job?.status === 'running', `status=${running.body?.job?.status}`)

    // log_offset slice
    const logSlice = await call('kanban_get_job', { job_id: jobId, log_offset: 0 }, devTok)
    check('get_job with log_offset returns a slice',
      typeof logSlice.body?.data === 'string' && typeof logSlice.body?.size === 'number',
      `keys=${Object.keys(logSlice.body ?? {}).join(',')}`)

    // ── list_jobs filtered by card_id ───────────────────────────
    const listRunning = await call('kanban_list_jobs', { card_id: cardId }, devTok)
    check('list_jobs by card_id → 200', listRunning.status === 200, `status=${listRunning.status}`)
    check('list_jobs finds our job',
      listRunning.body?.jobs?.some((j) => j.job_id === jobId),
      `jobs=${listRunning.body?.jobs?.map((j) => j.job_id).join(',')}`)

    // ── wait for completion ─────────────────────────────────────
    let final = null
    for (let i = 0; i < 30; i++) {
      const r = await call('kanban_get_job', { job_id: jobId }, devTok)
      if (r.body?.job?.status !== 'running') { final = r.body.job; break }
      await sleep(500)
    }
    check('job reached succeeded', final?.status === 'succeeded', `status=${final?.status}`)
    check('job exit_code 0', final?.exit_code === 0, `exit_code=${final?.exit_code}`)

    // Give the finalize's async card hand-back a moment to land.
    let c2 = null
    for (let i = 0; i < 20; i++) {
      const r = await call('kanban_get_card', { id: cardId }, devTok)
      if (r.body?.status === 'todo') { c2 = r.body; break }
      await sleep(300)
    }
    check('card handed back to todo', c2?.status === 'todo', `status=${c2?.status}`)
    check('card assigned_to cleared off the job',
      c2 && c2.assigned_to !== `job:${jobId}`, `assigned_to=${c2?.assigned_to}`)
    check('result logged on the card',
      typeof c2?.body === 'string' && c2.body.includes(jobId) && c2.body.includes('succeeded'),
      `body includes finish summary=${/finished/.test(c2?.body ?? '')}`)

    // ── list_jobs filtered by status ────────────────────────────
    const listDone = await call('kanban_list_jobs', { card_id: cardId, status: 'succeeded' }, devTok)
    check('list_jobs by status=succeeded finds it',
      listDone.body?.jobs?.some((j) => j.job_id === jobId && j.status === 'succeeded'),
      `jobs=${JSON.stringify(listDone.body?.jobs?.map((j) => [j.job_id, j.status]))}`)

    const listWrongStatus = await call('kanban_list_jobs', { card_id: cardId, status: 'running' }, devTok)
    check('list_jobs by status=running now empty',
      Array.isArray(listWrongStatus.body?.jobs) && listWrongStatus.body.jobs.length === 0,
      `n=${listWrongStatus.body?.jobs?.length}`)

  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} jobs check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Jobs smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
