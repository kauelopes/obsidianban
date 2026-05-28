#!/usr/bin/env node
// Sprint 03 batch 6 — editor advisory banner + error UI (409 modal, 400/500
// toasts, offline banner).
import { readFile } from 'node:fs/promises'

const PLUGIN_OUT = 'test-vault/.obsidian/plugins/obsidiankan-mcp'

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg)
  console.log('  ✓ ' + msg)
}

async function main() {
  console.log('=== Test A: bundle includes batch 6 wiring ===')
  const main = await readFile(`${PLUGIN_OUT}/main.js`, 'utf8')
  assert(main.includes('Managed card'), 'card advisory banner text present')
  assert(main.includes('file-open'), 'workspace file-open listener wired')
  assert(main.includes('kanban-mcp-card-banner'), 'banner CSS class present')
  assert(main.includes('Card changed elsewhere'), 'ConflictModal title present')
  assert(main.includes('Keep mine'), 'ConflictModal keep-mine action present')
  assert(main.includes('Use server version'), 'ConflictModal keep-theirs action present')
  assert(main.includes('kanban-mcp-offline-banner'), 'offline banner CSS class present')
  assert(main.includes('MCP is unreachable'), 'offline message present')
  assert(main.includes('Retry'), 'retry-toast button text present')

  console.log('=== Test B: styles use Obsidian CSS vars + .kanban-mcp- prefix ===')
  const styles = await readFile(`${PLUGIN_OUT}/styles.css`, 'utf8')
  assert(/\.kanban-mcp-card-banner\b/.test(styles), 'card-banner styled')
  assert(/\.kanban-mcp-offline-banner\b/.test(styles), 'offline-banner styled')
  assert(/\.kanban-mcp-conflict-buttons\b/.test(styles), 'conflict-buttons styled')
  assert(/\.kanban-mcp-toast-retry\b/.test(styles), 'toast-retry styled')
  assert(!/#[0-9a-fA-F]{3,6}\b/.test(styles), 'no hex colors (RULE-07)')
  assert(/var\(--background-modifier-error\)/.test(styles), 'uses --background-modifier-error')
  assert(/var\(--interactive-accent\)/.test(styles), 'uses --interactive-accent')

  console.log('\n✅ All batch 6 smoke assertions passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
