#!/usr/bin/env node
// Sprint 02 batch 3 — move/reorder/SSE/stdio.
import { rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

const VAULT = '/tmp/kanban-smoke-batch6'
const PORT = 13920
const BASE = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let mcpCounter = 0
function startMcp(extraArgs = []) {
  const tag = `mcp${++mcpCounter}`
  const child = spawn('node_modules/.bin/tsx', ['src/index.ts', ...extraArgs], {
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

// Minimal SSE client: parses chunks into events { id, event, data }.
function sseClient() {
  const events = []
  const ctl = new AbortController()
  ;(async () => {
    try {
      const res = await fetch(`${BASE}/events`, { signal: ctl.signal })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          const ev = { id: null, event: null, data: null }
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) ev.id = Number(line.slice(4))
            else if (line.startsWith('event: ')) ev.event = line.slice(7)
            else if (line.startsWith('data: ')) ev.data = JSON.parse(line.slice(6))
          }
          if (ev.event) events.push(ev)
        }
      }
    } catch {
      // aborted by close() — expected
    }
  })()
  return {
    events,
    close: () => ctl.abort(),
    ready: new Promise((r) => setTimeout(r, 200)), // small grace for headers
  }
}

async function main() {
  await rm(VAULT, { recursive: true, force: true })
  const tokA = extractRawToken((await runCli(['create', '--project', 'projA', '--role', 'agent', '--actor', 'agent:alice'])).stdout)
  const authA = { authorization: `Bearer ${tokA}` }

  const mcp = startMcp()
  await waitReady(mcp)

  try {
    console.log('=== Setup: seed 5 cards in backlog ===')
    const ids = []
    for (let i = 0; i < 5; i++) {
      const r = await callTool('kanban_create_card', {
        title: `card-${i}`, type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
      }, authA)
      assert(r.status === 200, `seed card ${i}`)
      ids.push(r.body.id)
    }

    console.log('=== Test 1: SSE client receives created events ===')
    const sse = sseClient()
    await sse.ready

    // create one more card; SSE should pick it up
    const newC = await callTool('kanban_create_card', {
      title: 'streamed', type: 'task', input_tokens: 1, output_tokens: 1, model: 'm',
    }, authA)
    await sleep(150)
    const created = sse.events.find((e) => e.event === 'CARD_CREATED' && e.data.card_id === newC.body.id)
    assert(created !== undefined, 'SSE CARD_CREATED received')
    assert(created.data.position === 6000, '  payload includes position')

    console.log('=== Test 2: move_card ===')
    // move card[0] from backlog → in-progress
    const mv = await callTool('kanban_move_card', {
      id: ids[0], version: 1, to_status: 'in-progress',
      input_tokens: 5, output_tokens: 10, model: 'm',
    }, authA)
    assert(mv.status === 200, 'move 200')
    assert(mv.body.status === 'in-progress', 'status changed')
    assert(mv.body.position === 1000, 'first in destination column → position 1000')
    assert(mv.body.version === 2, 'version incremented')

    await sleep(150)
    const movedEv = sse.events.find((e) => e.event === 'CARD_MOVED' && e.data.card_id === ids[0])
    assert(movedEv !== undefined, 'SSE CARD_MOVED received')
    assert(movedEv.data.from_status === 'backlog' && movedEv.data.to_status === 'in-progress', '  from/to in payload')

    console.log('=== Test 3: move conflicts ===')
    const badTo = await callTool('kanban_move_card', {
      id: ids[1], version: 1, to_status: 'nope', input_tokens: 1, output_tokens: 1, model: 'm',
    }, authA)
    assert(badTo.status === 400, 'unknown to_status → 400')

    const stale = await callTool('kanban_move_card', {
      id: ids[1], version: 99, to_status: 'in-progress', input_tokens: 1, output_tokens: 1, model: 'm',
    }, authA)
    assert(stale.status === 409, 'stale version → 409')
    assert(stale.body.conflicting_fields.includes('status'), '  status in conflicting_fields')

    console.log('=== Test 4: reorder ===')
    // Current backlog after move: ids[1..4] with positions 2000, 3000, 4000, 5000 (ids[5]=newC at 6000)
    // Move ids[3] to top (after_card_id = null)
    const rev = await callTool('kanban_reorder_card', {
      id: ids[3], version: 1, after_card_id: null,
      input_tokens: 2, output_tokens: 3, model: 'm',
    }, authA)
    assert(rev.status === 200, 'reorder 200')
    const positions = rev.body.affected_cards.map((c) => c.new_position)
    assert(positions.every((p) => p % 1000 === 0), 'all affected positions are multiples of 1000')
    const target = rev.body.affected_cards.find((c) => c.id === ids[3])
    assert(target.new_position === 1000, 'reordered card now at position 1000 (top)')

    // Verify positions are normalized: 1000, 2000, 3000, 4000, 5000 in some order
    const listAfter = await callTool('kanban_list_cards', { status: 'backlog' }, authA)
    const backlogPositions = listAfter.body.cards.map((c) => c.position)
    assert(JSON.stringify(backlogPositions) === JSON.stringify([1000, 2000, 3000, 4000, 5000]), 'column normalized to 1000..5000')

    // ids[3] should be first now
    assert(listAfter.body.cards[0].id === ids[3], 'reordered card is first')

    await sleep(150)
    const reorderedEv = sse.events.find((e) => e.event === 'CARD_REORDERED' && e.data.affected_cards.some((c) => c.id === ids[3]))
    assert(reorderedEv !== undefined, 'SSE CARD_REORDERED received')

    console.log('=== Test 5: reorder rejects cross-column after_card_id ===')
    const xCol = await callTool('kanban_reorder_card', {
      id: ids[3], version: rev.body.card.version, after_card_id: ids[0], // ids[0] is in in-progress
      input_tokens: 1, output_tokens: 1, model: 'm',
    }, authA)
    assert(xCol.status === 400, 'after_card_id in another column → 400')

    console.log('=== Test 6: SSE replay via Last-Event-ID ===')
    // Connect a second client and replay everything
    const sse2 = sseClient()
    await sse2.ready
    await sleep(300)
    assert(sse2.events.length === 0, 'fresh client without Last-Event-ID gets no history')

    const replayCtl = new AbortController()
    const replayRes = await fetch(`${BASE}/events`, {
      headers: { 'last-event-id': '0' },
      signal: replayCtl.signal,
    })
    const reader = replayRes.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    const replayed = []
    const replayStart = Date.now()
    while (Date.now() - replayStart < 800) {
      const { value, done } = await Promise.race([
        reader.read(),
        sleep(200).then(() => ({ value: undefined, done: false })),
      ])
      if (done) break
      if (!value) continue
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) replayed.push(line.slice(7))
        }
      }
    }
    replayCtl.abort()
    assert(replayed.length >= 8, `replay yields all events (got ${replayed.length})`)
    assert(replayed.includes('CARD_CREATED'), '  replay includes CARD_CREATED')
    assert(replayed.includes('CARD_MOVED'), '  replay includes CARD_MOVED')
    assert(replayed.includes('CARD_REORDERED'), '  replay includes CARD_REORDERED')

    sse.close()
    sse2.close()
  } finally {
    await stopMcp(mcp)
  }

  console.log('\n=== Test 7: stdio transport ===')
  // Stop HTTP, start in stdio mode using same vault.
  // Sub-test 7a: missing token → exit code 1
  const noToken = spawn('node_modules/.bin/tsx', ['src/index.ts', '--stdio'], {
    env: { ...process.env, VAULT_PATH: VAULT, KANBAN_MCP_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const noTokenExit = await new Promise((r) => noToken.on('exit', r))
  assert(noTokenExit !== 0, '--stdio without KANBAN_MCP_TOKEN exits non-zero')

  const invalidToken = spawn('node_modules/.bin/tsx', ['src/index.ts', '--stdio'], {
    env: { ...process.env, VAULT_PATH: VAULT, KANBAN_MCP_TOKEN: 'not-real' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const invalidExit = await new Promise((r) => invalidToken.on('exit', r))
  assert(invalidExit !== 0, '--stdio with invalid KANBAN_MCP_TOKEN exits non-zero')

  // 7c: valid stdio - send tools/list and tools/call, parse responses
  const stdio = spawn('node_modules/.bin/tsx', ['src/index.ts', '--stdio'], {
    env: { ...process.env, VAULT_PATH: VAULT, KANBAN_MCP_TOKEN: tokA },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  stdio.stderr.on('data', (d) => process.stderr.write(`[stdio-err] ${d}`))

  let stdoutBuf = ''
  const responses = []
  stdio.stdout.on('data', (d) => {
    stdoutBuf += d.toString()
    let nl
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim()
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (line) responses.push(JSON.parse(line))
    }
  })

  // Wait for stdio "ready" line on stderr
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stdio ready timeout')), 8000)
    stdio.stderr.on('data', (d) => {
      if (d.toString().includes('stdio:') && d.toString().includes('ready')) {
        clearTimeout(timer)
        resolve()
      }
    })
  })

  function sendJsonRpc(payload) {
    stdio.stdin.write(JSON.stringify(payload) + '\n')
  }
  async function nextResponse(id, timeoutMs = 3000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const found = responses.find((r) => r.id === id)
      if (found) return found
      await sleep(50)
    }
    throw new Error(`stdio: no response for id=${id}`)
  }

  // initialize
  sendJsonRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } })
  const initRes = await nextResponse(1)
  assert(initRes.result !== undefined, 'stdio: initialize succeeds')
  sendJsonRpc({ jsonrpc: '2.0', method: 'notifications/initialized' })

  sendJsonRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const listRes = await nextResponse(2)
  assert(listRes.result.tools.length === 6, 'stdio: tools/list returns 6 tools')

  // call kanban_list_cards via stdio
  sendJsonRpc({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'kanban_list_cards', arguments: { status: 'backlog' } },
  })
  const callRes = await nextResponse(3)
  const parsed = JSON.parse(callRes.result.content[0].text)
  assert(Array.isArray(parsed.cards) && parsed.cards.length === 5, 'stdio: tools/call kanban_list_cards returns 5 backlog cards')

  stdio.kill('SIGTERM')
  await new Promise((r) => stdio.on('exit', r))
  console.log('  ✓ stdio transport happy path')

  console.log('\nALL TESTS PASSED')
}

main().catch((e) => {
  console.error('FAILED:', e)
  process.exit(1)
})
