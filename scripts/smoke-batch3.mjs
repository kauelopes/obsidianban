#!/usr/bin/env node
// End-to-end smoke for Sprint 01 batch 3 (TASK-06/07/08/08b).
// Exercises the kanban-token CLI, HTTP server, /health endpoint,
// auth middleware behaviour and idempotency store.
import { rm, readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const VAULT = '/tmp/kanban-smoke-batch3'
const PORT = 13800
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let mcpCounter = 0
function startMcp() {
  const tag = `mcp${++mcpCounter}`
  const child = spawn('node_modules/.bin/tsx', ['src/index.ts'], {
    env: { ...process.env, VAULT_PATH: VAULT, MCP_HTTP_PORT: String(PORT) },
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
    sleep(2000).then(() => { try { child.kill('SIGKILL') } catch {} }),
  ])
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

function runCli(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['src/auth/cli.ts', ...args], {
      env: { ...process.env, VAULT_PATH: VAULT, ...env },
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

async function callTool(name, body, headers = {}) {
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

  console.log('=== Test 1: token CLI creates agent + manager tokens ===')
  const agentRes = await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:alice'])
  assert(agentRes.code === 0, 'agent create exits 0')
  const agentToken = extractRawToken(agentRes.stdout)
  assert(agentToken.length > 20, 'agent token is non-empty random string')

  const mgrRes = await runCli(['create', '--role', 'manager', '--actor', 'human:boss'])
  assert(mgrRes.code === 0, 'manager create exits 0')
  const mgrToken = extractRawToken(mgrRes.stdout)

  const listAgentRes = await runCli(['list', '--project', 'projA'])
  assert(!listAgentRes.stdout.includes(agentToken), 'list never prints raw token')

  const listMgrRes = await runCli(['list', '--manager'])
  assert(!listMgrRes.stdout.includes(mgrToken), 'list never prints raw manager token')

  const meta = JSON.parse(await readFile(path.join(VAULT, '.kanban-data', 'projA', '_meta.json'), 'utf8'))
  assert(meta.agent_tokens.length === 1, '_meta.json has 1 agent token record')
  assert(!JSON.stringify(meta).includes(agentToken), 'raw token never persisted to _meta.json')

  console.log('=== Test 2: /health responds 200 with payload ===')
  const mcp1 = startMcp()
  await waitReady(mcp1)
  const health = await fetch(`${BASE}/health`).then((r) => r.json())
  assert(health.status === 'ok', '/health status=ok after startup')
  assert(typeof health.uptime_s === 'number', '/health includes uptime_s')
  assert(health.vault === VAULT, '/health includes vault path')
  assert(health.cards_indexed === 0, '/health reports cards_indexed=0')

  console.log('=== Test 3: auth middleware ===')
  const noAuth = await callTool('placeholder', {})
  assert(noAuth.status === 401, 'missing token → 401')
  assert(noAuth.body.error === 'missing_token', '  reason: missing_token')

  const badAuth = await callTool('placeholder', {}, { authorization: 'Bearer not-a-real-token' })
  assert(badAuth.status === 401, 'invalid token → 401')
  assert(badAuth.body.error === 'invalid_token', '  reason: invalid_token')

  const okAgent = await callTool('placeholder', {}, { authorization: `Bearer ${agentToken}` })
  assert(okAgent.status === 501, 'valid agent token reaches dispatch (501 not_implemented)')

  const okMgr = await callTool('placeholder', {}, { authorization: `Bearer ${mgrToken}` })
  assert(okMgr.status === 501, 'valid manager token reaches dispatch')

  console.log('=== Test 4: idempotency ===')
  const badId = await callTool('placeholder', { request_id: 'not-a-uuid' }, { authorization: `Bearer ${agentToken}` })
  assert(badId.status === 400 && badId.body.error === 'invalid_request_id', 'non-UUID request_id → 400')

  const validUuid = randomUUID()
  const first = await callTool('placeholder', { request_id: validUuid }, { authorization: `Bearer ${agentToken}` })
  assert(first.status === 501, 'valid request_id but no handler → still 501 (no cache yet)')

  // Idempotency caches only successful responses (200). A 501 isn't cached
  // because the handler never ran. So second call also gets 501.
  const second = await callTool('placeholder', { request_id: validUuid }, { authorization: `Bearer ${agentToken}` })
  assert(second.status === 501, 'second call without registered tool: still 501')

  console.log('=== Test 5: revoke ===')
  await stopMcp(mcp1)
  const listed = await runCli(['list', '--project', 'projA'])
  const tokenId = JSON.parse(listed.stdout.split('\n')[0]).token_id
  const revokeRes = await runCli(['revoke', '--project', 'projA', '--token-id', tokenId])
  assert(revokeRes.code === 0, 'revoke succeeds')

  const mcp2 = startMcp()
  await waitReady(mcp2)
  const revokedAuth = await callTool('placeholder', {}, { authorization: `Bearer ${agentToken}` })
  assert(revokedAuth.status === 401, 'revoked token → 401')
  assert(revokedAuth.body.error === 'revoked_token', '  reason: revoked_token')
  await stopMcp(mcp2)

  console.log('\nALL TESTS PASSED')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
