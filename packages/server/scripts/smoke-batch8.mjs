#!/usr/bin/env node
// Sprint 03 batch 2 — plugin scaffold + HTTP client.
// We spawn the MCP server and exercise plugin/src/mcp/client.ts via tsx.
import { rm, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const VAULT = '/tmp/kanban-smoke-batch8'
const PORT = 13922
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

async function main() {
  console.log('=== Test A: build artifacts ===')
  assert(existsSync('test-vault/.obsidian/plugins/obsidiankan-mcp/main.js'), 'main.js exists')
  assert(existsSync('test-vault/.obsidian/plugins/obsidiankan-mcp/manifest.json'), 'manifest.json exists')
  assert(existsSync('test-vault/.obsidian/plugins/obsidiankan-mcp/styles.css'), 'styles.css exists')
  const manifest = JSON.parse(await readFile('test-vault/.obsidian/plugins/obsidiankan-mcp/manifest.json', 'utf8'))
  assert(manifest.id === 'obsidiankan-mcp', 'manifest.id = obsidiankan-mcp')
  assert(manifest.isDesktopOnly === true, 'manifest.isDesktopOnly = true')
  assert(typeof manifest.minAppVersion === 'string', 'manifest.minAppVersion is string')

  console.log('=== Test B: client against live MCP ===')
  await rm(VAULT, { recursive: true, force: true })
  const tok = extractRawToken((await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:alice'])).stdout)

  const mcp = startMcp()
  await waitReady(mcp)
  try {
    // Drive the client via a child tsx process so we exercise the real
    // module exports — not a JS reimplementation.
    const runnerOutput = await runRunner(tok)
    const lines = runnerOutput.trim().split('\n')
    for (const line of lines) {
      const [tag, ...rest] = line.split('|')
      assert(tag === 'PASS', `${rest.join('|')} (raw: ${line})`)
    }
  } finally {
    await stopMcp(mcp)
  }

  console.log('\n✅ All plugin scaffold + HTTP client smoke tests passed.')
}

function runRunner(token) {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['scripts/_batch8-client-runner.ts'], {
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

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
