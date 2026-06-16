#!/usr/bin/env node
// Sprint 03 batch 5 — SSE subscriber + event mapping.
import { rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const VAULT = '/tmp/kanban-smoke-batch11'
const PORT = 13923
const PLUGIN_OUT = 'test-vault/.obsidian/plugins/obsidiankan-mcp'
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

function runSseRunner(token) {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['scripts/_batch11-sse-runner.ts'], {
      env: { ...process.env, MCP_TOKEN: token, MCP_PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d.toString()))
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`runner exit ${code}: ${stderr}\n${stdout}`))
      else resolve(stdout)
    })
    child.on('error', reject)
  })
}

async function main() {
  console.log('=== Test A: build artifacts include SSE wiring ===')
  const main = await readFile(`${PLUGIN_OUT}/main.js`, 'utf8')
  assert(main.includes('SSESubscriber') || main.includes('text/event-stream'), 'SSE wiring present in bundle')
  assert(main.includes('last-event-id') || main.includes('Last-Event-ID'), 'Last-Event-ID resume header present')
  assert(main.includes('handleSseEvent') || main.includes('CARD_MOVED'), 'event dispatch present')

  console.log('=== Test B: live subscriber + mutations ===')
  await rm(VAULT, { recursive: true, force: true })
  const tok = extractRawToken((await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:alice'])).stdout)

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    const out = await runSseRunner(tok)
    const lines = out.trim().split('\n')
    for (const line of lines) {
      const [tag, ...rest] = line.split('|')
      assert(tag === 'PASS', `${rest.join('|')} (raw: ${line})`)
    }
  } finally {
    await stopMcp(mcp)
  }

  console.log('\n✅ All SSE smoke tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
