#!/usr/bin/env node
// Sprint 03 batch 4 — drag/drop, create, optimistic UI.
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const PLUGIN_OUT = 'test-vault/.obsidian/plugins/obsidiankan-mcp'

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg)
  console.log('  ✓ ' + msg)
}

function runStateRunner() {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['scripts/_batch10-state-runner.ts'], {
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
  console.log('=== Test A: build artifacts include drag/create wiring ===')
  const main = await readFile(`${PLUGIN_OUT}/main.js`, 'utf8')
  assert(main.includes('text/x-kanban-mcp'), 'dataTransfer mime present')
  assert(main.includes('kanban-mcp-column-dragover'), 'dragover class present')
  assert(main.includes('kanban-mcp-card-dragging'), 'dragging class present')
  assert(main.includes('kanban_create_card') || main.includes('createCard'), 'create flow present in bundle')
  assert(main.includes('kanban_move_card') || main.includes('moveCard'), 'move flow present in bundle')
  assert(main.includes('New card'), 'create modal title present')
  assert(main.includes('Cannot move card across projects'), 'cross-project guard present')

  const styles = await readFile(`${PLUGIN_OUT}/styles.css`, 'utf8')
  assert(/\.kanban-mcp-column-add\b/.test(styles), 'add-card button styled')
  assert(/\.kanban-mcp-column-dragover\b/.test(styles), 'dragover style present')
  assert(/\.kanban-mcp-card-dragging\b/.test(styles), 'dragging style present')
  assert(/cursor:\s*grab/.test(styles), 'cards have grab cursor')

  console.log('=== Test B: pure state helpers (optimistic + rollback) ===')
  const out = await runStateRunner()
  const lines = out.trim().split('\n')
  for (const line of lines) {
    const [tag, ...rest] = line.split('|')
    assert(tag === 'PASS', `${rest.join('|')} (raw: ${line})`)
  }

  console.log('\n✅ All drag/create/optimistic smoke tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
