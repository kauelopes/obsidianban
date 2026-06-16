#!/usr/bin/env node
// Sprint 03 batch 6b — title-derived filenames + collision/rename semantics.
import { rm, rename } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { spawn } from 'node:child_process'

const VAULT = '/tmp/kanban-smoke-batch13'
const PORT = 13924
const BASE = `http://127.0.0.1:${PORT}`
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
  if (!m) throw new Error('could not parse token')
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

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const tok = extractRawToken((await runCli(['create', '--project', 'p', '--role', 'agent', '--actor', 'agent:t'])).stdout)
  const auth = { authorization: `Bearer ${tok}` }

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    console.log('=== Test 1: filename derived from title ===')
    const c1 = await callTool('kanban_create_card', {
      title: 'Hello World', type: 'task', input_tokens: 0, output_tokens: 0, model: 'm',
    }, auth)
    assert(c1.status === 200, 'create 200')
    assert(c1.body.file_basename === 'Hello World', `basename = 'Hello World' (got ${JSON.stringify(c1.body.file_basename)})`)
    assert(existsSync(`${VAULT}/kanban-data/p/Hello World.md`), 'file written at expected basename')
    assert(!existsSync(`${VAULT}/kanban-data/p/${c1.body.id}.md`), 'no legacy id-based file')

    console.log('=== Test 2: collision → suffix ===')
    const c2 = await callTool('kanban_create_card', {
      title: 'Hello World', type: 'task', input_tokens: 0, output_tokens: 0, model: 'm',
    }, auth)
    assert(c2.status === 200, 'create dup 200')
    assert(c2.body.file_basename === 'Hello World (2)', `basename = 'Hello World (2)' (got ${JSON.stringify(c2.body.file_basename)})`)
    assert(existsSync(`${VAULT}/kanban-data/p/Hello World (2).md`), 'collision file written with suffix')

    console.log('=== Test 3: illegal chars stripped ===')
    const c3 = await callTool('kanban_create_card', {
      title: 'Path/with:bad*chars?<>"|', type: 'task',
      input_tokens: 0, output_tokens: 0, model: 'm',
    }, auth)
    assert(c3.status === 200, 'create with bad chars 200')
    assert(c3.body.file_basename === 'Pathwithbadchars', `illegal chars stripped (got ${JSON.stringify(c3.body.file_basename)})`)

    console.log('=== Test 4: title update renames the file ===')
    const u = await callTool('kanban_update_card', {
      id: c1.body.id, version: 1, title: 'Renamed',
      input_tokens: 0, output_tokens: 0, model: 'm',
    }, auth)
    assert(u.status === 200, 'update 200')
    assert(u.body.file_basename === 'Renamed', `basename now 'Renamed'`)
    assert(existsSync(`${VAULT}/kanban-data/p/Renamed.md`), 'new file exists')
    assert(!existsSync(`${VAULT}/kanban-data/p/Hello World.md`), 'old file removed')

    console.log('=== Test 5: move keeps basename ===')
    const m = await callTool('kanban_move_card', {
      id: u.body.id, version: 2, to_status: 'todo',
      input_tokens: 0, output_tokens: 0, model: 'm',
    }, auth)
    assert(m.status === 200, 'move 200')
    assert(m.body.file_basename === 'Renamed', 'move did not rename')
    assert(existsSync(`${VAULT}/kanban-data/p/Renamed.md`), 'file still at Renamed.md')

    console.log('=== Test 6: delete by basename ===')
    const d = await callTool('kanban_delete_card', {
      id: u.body.id, version: 3, input_tokens: 0, output_tokens: 0, model: 'm',
    }, auth)
    assert(d.status === 200, 'delete 200')
    assert(!existsSync(`${VAULT}/kanban-data/p/Renamed.md`), 'file removed by delete')

    console.log('=== Test 7: list returns file_basename ===')
    const list = await callTool('kanban_list_cards', {}, auth)
    assert(list.status === 200, 'list 200')
    assert(list.body.cards.every((c) => typeof c.file_basename === 'string'), 'every card has file_basename')
    const remaining = readdirSync(`${VAULT}/kanban-data/p/`).filter((f) => f.endsWith('.md')).sort()
    assert(JSON.stringify(remaining) === JSON.stringify(['Hello World (2).md', 'Pathwithbadchars.md']), `remaining files: ${remaining.join(',')}`)

    console.log('=== Test 8: user-rename on disk → watcher updates basename ===')
    const c4 = await callTool('kanban_create_card', {
      title: 'BeforeRename', type: 'task', input_tokens: 0, output_tokens: 0, model: 'm',
    }, auth)
    assert(c4.status === 200, 'seed card created')
    const oldPath = `${VAULT}/kanban-data/p/BeforeRename.md`
    const newPath = `${VAULT}/kanban-data/p/AfterRename.md`
    await rename(oldPath, newPath)
    // chokidar debounce (DEBOUNCE_MS = 500) + a small buffer
    await sleep(900)
    const list2 = await callTool('kanban_list_cards', {}, auth)
    const renamed = list2.body.cards.find((c) => c.id === c4.body.id)
    assert(renamed && renamed.file_basename === 'AfterRename', `basename updated by watcher (got ${JSON.stringify(renamed?.file_basename)})`)
    assert(existsSync(newPath) && !existsSync(oldPath), 'only the new file remains on disk')

    console.log('\n✅ All filename refactor smoke tests passed.')
  } finally {
    await stopMcp(mcp)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
