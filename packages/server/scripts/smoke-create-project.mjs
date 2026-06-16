#!/usr/bin/env node
// Create-project smoke. Covers the round trip for kanban_create_project:
// manager-only gate, project-name validation, folder + meta side effects,
// additive re-mint, and the freshly-minted token actually working as auth
// for follow-up agent calls.

import { rm, readFile, stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-create-project'
const PORT = 13955
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

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const mgrTok = extractRawToken((await runCli([
    'create', '--role', 'manager', '--actor', 'admin:me',
  ])).stdout)
  // Pre-existing agent token so we can verify the role gate rejects it.
  const preAgentTok = extractRawToken((await runCli([
    'create', '--project', 'preexisting', '--role', 'agent', '--actor', 'agent:bob',
  ])).stdout)

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Create-project smoke ===')

    // 1. Happy path: manager creates a brand-new project.
    const r1 = await call('kanban_create_project',
      { project: 'first-proj', actor: 'agent:alice' }, mgrTok)
    check('manager create → 200', r1.status === 200, `status=${r1.status}`)
    check('response carries raw token',
      typeof r1.body.token === 'string' && r1.body.token.length > 20,
      `token.len=${r1.body.token?.length}`)
    check('response carries token_id', typeof r1.body.token_id === 'string',
      `token_id=${r1.body.token_id}`)

    // 2. Folder + project meta materialized on disk.
    const projDir = path.join(VAULT, 'kanban-data', 'first-proj')
    const projMeta = path.join(projDir, '_meta.json')
    const st = await stat(projDir).catch(() => null)
    check('project folder created', st?.isDirectory() === true, projDir)
    const meta = JSON.parse(await readFile(projMeta, 'utf8'))
    check('agent_tokens has one entry',
      meta.agent_tokens?.length === 1,
      `n=${meta.agent_tokens?.length}`)

    // 3. Agent token cannot create projects (role gate).
    const r2 = await call('kanban_create_project',
      { project: 'forbidden-proj', actor: 'agent:eve' }, preAgentTok)
    check('agent token → 403', r2.status === 403, `status=${r2.status}`)
    check('error body says manager_required',
      r2.body.reason === 'manager_required', `reason=${r2.body.reason}`)

    // 4. Path-traversal in project name is rejected.
    const r3 = await call('kanban_create_project',
      { project: '../evil', actor: 'agent:eve' }, mgrTok)
    check('path-traversal project rejected',
      r3.status === 400 && r3.body.error === 'invalid_field',
      `status=${r3.status} error=${r3.body.error}`)

    // 5. Bad actor characters rejected (slashes).
    const r4 = await call('kanban_create_project',
      { project: 'okproj', actor: 'agent/with/slash' }, mgrTok)
    check('bad actor rejected',
      r4.status === 400 && r4.body.field === 'actor',
      `status=${r4.status} field=${r4.body.field}`)

    // 6. First-mint side effect: a starter card was seeded in backlog.
    check('first mint returns starter_card_id',
      typeof r1.body.starter_card_id === 'string',
      `starter_card_id=${r1.body.starter_card_id}`)
    const listAfterFirst = await call('kanban_list_cards',
      { include_archived: false }, r1.body.token)
    const starter = listAfterFirst.body.cards.find((c) => c.id === r1.body.starter_card_id)
    check('starter card is in backlog',
      starter?.status === 'backlog',
      `status=${starter?.status}`)
    check('starter card title is the onboarding card',
      starter?.title?.startsWith('Agent setup'),
      `title=${starter?.title}`)

    // 7. Re-mint on existing project: folder reused, second token added,
    //    no second starter card.
    const r5 = await call('kanban_create_project',
      { project: 'first-proj', actor: 'agent:charlie' }, mgrTok)
    check('re-mint same project → 200', r5.status === 200, `status=${r5.status}`)
    check('re-mint returns a different token',
      r5.body.token !== r1.body.token, `eq=${r5.body.token === r1.body.token}`)
    check('re-mint does NOT seed another starter card',
      r5.body.starter_card_id === null,
      `starter_card_id=${r5.body.starter_card_id}`)
    const meta2 = JSON.parse(await readFile(projMeta, 'utf8'))
    check('agent_tokens now has two entries',
      meta2.agent_tokens?.length === 2,
      `n=${meta2.agent_tokens?.length}`)
    check('original token preserved',
      meta2.agent_tokens.some((t) => t.token_id === r1.body.token_id),
      `ids=${meta2.agent_tokens.map((t) => t.token_id).join(',')}`)

    // 8. The freshly-minted token actually authenticates an agent call.
    const r6 = await call('kanban_create_card',
      { title: 'first card', type: 'task',
        input_tokens: 0, output_tokens: 0, model: 'smoke' }, r1.body.token)
    check('minted token authenticates create_card',
      r6.status === 200 && r6.body.project === 'first-proj',
      `status=${r6.status} project=${r6.body?.project}`)

    // 9. Manager lists all projects (including the unrelated 'preexisting'
    //    one we minted via the CLI at the start).
    const lpMgr = await call('kanban_list_projects', {}, mgrTok)
    check('manager list_projects → 200', lpMgr.status === 200, `status=${lpMgr.status}`)
    const mgrProjectNames = (lpMgr.body.projects ?? []).map((p) => p.project).sort()
    check('manager sees both projects',
      JSON.stringify(mgrProjectNames) === JSON.stringify(['first-proj', 'preexisting']),
      `projects=${mgrProjectNames.join(',')}`)
    const firstShape = (lpMgr.body.projects ?? []).find((p) => p.project === 'first-proj')
    check('manager sees columns on first-proj',
      Array.isArray(firstShape?.columns) && firstShape.columns.includes('backlog'),
      `cols=${firstShape?.columns?.join(',')}`)

    // 10. Agent only sees their own project.
    const lpAgent = await call('kanban_list_projects', {}, r1.body.token)
    check('agent list_projects → 200', lpAgent.status === 200, `status=${lpAgent.status}`)
    check('agent sees only their own project',
      lpAgent.body.projects?.length === 1
        && lpAgent.body.projects[0].project === 'first-proj',
      `projects=${(lpAgent.body.projects ?? []).map((p) => p.project).join(',')}`)
  } finally {
    await stopMcp(mcp)
  }

  if (failures > 0) {
    console.error(`\n❌ ${failures} create-project check(s) failed`)
    process.exit(1)
  }
  console.log('\n✅ Create-project smoke passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
