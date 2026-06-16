#!/usr/bin/env node
// Sprint 03 batch 3 — board render (read-only).
// Verifies pure render logic + that the bundle includes the view module.
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

const PLUGIN_OUT = 'test-vault/.obsidian/plugins/obsidiankan-mcp'

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg)
  console.log('  ✓ ' + msg)
}

function runRenderRunner() {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['scripts/_batch9-render-runner.ts'], {
      env: { ...process.env },
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
  console.log('=== Test A: build artifacts include view module ===')
  assert(existsSync(`${PLUGIN_OUT}/main.js`), 'main.js exists')
  const main = await readFile(`${PLUGIN_OUT}/main.js`, 'utf8')
  assert(main.includes('kanban-mcp-board'), 'bundle includes VIEW_TYPE constant')
  assert(main.includes('open-kanban-board'), 'bundle includes command id')
  assert(main.includes('kanban-mcp-card'), 'bundle includes render CSS class')

  const styles = await readFile(`${PLUGIN_OUT}/styles.css`, 'utf8')
  assert(styles.includes('var(--background-secondary)'), 'styles use Obsidian CSS vars')
  assert(!/#[0-9a-fA-F]{3,6}\b/.test(styles), 'styles have no hex colors (RULE-07)')
  assert(/\.kanban-mcp-/.test(styles), 'styles use .kanban-mcp- prefix (RULE-07)')

  console.log('=== Test B: pure render logic ===')
  const out = await runRenderRunner()
  const lines = out.trim().split('\n')
  for (const line of lines) {
    const [tag, ...rest] = line.split('|')
    assert(tag === 'PASS', `${rest.join('|')} (raw: ${line})`)
  }

  console.log('\n✅ All board render smoke tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
