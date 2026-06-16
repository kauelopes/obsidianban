#!/usr/bin/env node
// Sprint 03 batch 8 — metrics panel.
import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'

const PLUGIN_OUT = 'test-vault/.obsidian/plugins/obsidiankan-mcp'

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg)
  console.log('  ✓ ' + msg)
}

function runRenderRunner() {
  return new Promise((resolve, reject) => {
    const child = spawn('node_modules/.bin/tsx', ['scripts/_batch15-metrics-runner.ts'], {
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
  console.log('=== Test A: bundle includes metrics view + command ===')
  const main = await readFile(`${PLUGIN_OUT}/main.js`, 'utf8')
  assert(main.includes('kanban-mcp-metrics'), 'metrics view type constant present')
  assert(main.includes('show-metrics-panel'), 'show-metrics-panel command id present')
  assert(main.includes('Show metrics panel'), 'command name present')
  assert(main.includes('Kanban metrics'), 'view display text present')
  assert(main.includes('getMetrics'), 'client.getMetrics call wired')
  assert(main.includes('By type') && main.includes('By day') && main.includes('By model'), 'all three tables rendered')

  console.log('=== Test B: styles use Obsidian CSS vars (RULE-07) ===')
  const styles = await readFile(`${PLUGIN_OUT}/styles.css`, 'utf8')
  assert(/\.kanban-mcp-metrics\b/.test(styles), 'metrics panel styled')
  assert(/\.kanban-mcp-metrics-table\b/.test(styles), 'metrics table styled')
  assert(/\.kanban-mcp-metrics-stat\b/.test(styles), 'metrics stat card styled')
  assert(!/#[0-9a-fA-F]{3,6}\b/.test(styles), 'no hex colors')

  console.log('=== Test C: pure render helpers ===')
  const out = await runRenderRunner()
  const lines = out.trim().split('\n')
  for (const line of lines) {
    const [tag, ...rest] = line.split('|')
    assert(tag === 'PASS', `${rest.join('|')} (raw: ${line})`)
  }

  console.log('\n✅ All metrics panel smoke tests passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
