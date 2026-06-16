#!/usr/bin/env node
// Sprint 03 batch 7 — RULE-02..09 compliance audit (TASK-24..27).
// Pure static checks against plugin/ source + built bundle.
import { readFile } from 'node:fs/promises'
import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const PLUGIN_SRC = 'plugin/src'
const PLUGIN_OUT = 'test-vault/.obsidian/plugins/obsidiankan-mcp'

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERT: ' + msg)
  console.log('  ✓ ' + msg)
}

function listSourceFiles(root) {
  const out = []
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry)
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full))
    else if (full.endsWith('.ts')) out.push(full)
  }
  return out
}

async function readAll(files) {
  const map = new Map()
  for (const f of files) map.set(f, await readFile(f, 'utf8'))
  return map
}

function findMatches(sources, regex) {
  const hits = []
  for (const [file, content] of sources) {
    if (regex.test(content)) hits.push(file)
  }
  return hits
}

async function main() {
  const sourceFiles = listSourceFiles(PLUGIN_SRC)
  const sources = await readAll(sourceFiles)

  console.log('=== RULE-02: lifecycle (no raw window/document listeners or setInterval) ===')
  assert(
    findMatches(sources, /window\.addEventListener|document\.addEventListener/).length === 0,
    'no window/document addEventListener',
  )
  assert(
    findMatches(sources, /\bsetInterval\s*\(/).length === 0,
    'no direct setInterval (use registerInterval instead)',
  )

  console.log('=== RULE-03: vault API (no Node fs) ===')
  assert(
    findMatches(sources, /require\(['"]fs['"]\)|from\s+['"]fs['"]|from\s+['"]node:fs['"]|import\s+fs\b/).length === 0,
    'no Node fs imports in plugin/',
  )

  console.log('=== RULE-04: no view fields on Plugin ===')
  assert(
    findMatches(sources, /\bthis\.kanbanView\b|\bthis\.view\s*=/).length === 0,
    'no this.kanbanView or this.view = ... patterns',
  )

  console.log('=== RULE-05: onunload() does not detachLeavesOfType ===')
  const detachHits = findMatches(sources, /\.detachLeavesOfType\(/)
  // Only acceptable mention is the comment in main.ts explaining why we DON'T use it.
  for (const file of detachHits) {
    const content = sources.get(file)
    const lines = content.split('\n')
    const violations = lines
      .map((l, i) => ({ l, i }))
      .filter((x) => /\.detachLeavesOfType\(/.test(x.l) && !x.l.trim().startsWith('//'))
    assert(violations.length === 0, `${file}: no detachLeavesOfType call (only comment allowed)`)
  }
  assert(true, 'detachLeavesOfType call sites: none')

  console.log('=== RULE-06: narrowing via instanceof, no TFile/TFolder casts ===')
  assert(
    findMatches(sources, /\bas\s+TFile\b|\bas\s+TFolder\b/).length === 0,
    'no `as TFile` or `as TFolder` casts',
  )

  console.log('=== RULE-07: CSS uses Obsidian vars, no hex colors, .kanban-mcp- prefix ===')
  const styles = await readFile(`${PLUGIN_OUT}/styles.css`, 'utf8')
  assert(!/#[0-9a-fA-F]{3,6}\b/.test(styles), 'no hex colors in styles.css')
  assert(!/outline:\s*none/.test(styles), 'no `outline: none` (would break focus)')
  const ruleSelectors = styles.match(/^[^{}\n]+\{/gm) ?? []
  const offending = ruleSelectors
    .map((s) => s.replace('{', '').trim())
    .filter((s) => s.length > 0 && !s.startsWith('/*'))
    .filter((s) => {
      // Allow either our own prefix or selectors targeting Obsidian-native
      // classes from within our scoped namespace (.kanban-mcp-* descendant).
      return !s.includes('.kanban-mcp-') && !s.startsWith('@')
    })
  assert(offending.length === 0, `all selectors scoped to .kanban-mcp- (offending: ${offending.join(' | ')})`)

  console.log('=== RULE-08: command id/name conventions ===')
  const mainTs = sources.get(path.join(PLUGIN_SRC, 'main.ts')) ?? ''
  const idMatches = [...mainTs.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  assert(idMatches.length > 0, 'at least one command registered')
  for (const id of idMatches) {
    assert(/^[a-z][a-z0-9-]*$/.test(id), `command id "${id}" is lowercase hyphenated`)
    assert(!/^obsidiankan|kanban-mcp/.test(id), `command id "${id}" has no plugin prefix`)
    assert(!/command$/i.test(id), `command id "${id}" does not end with "command"`)
  }
  const nameMatches = [...mainTs.matchAll(/name:\s*['"]([^'"]+)['"]/g)].map((m) => m[1])
  for (const name of nameMatches) {
    const words = name.split(/\s+/)
    assert(words.length > 0 && /^[A-Z]/.test(words[0]), `command name "${name}" first word is capitalized`)
    const allLowerRest = words.slice(1).every((w) => /^[a-z]/.test(w))
    assert(allLowerRest, `command name "${name}" subsequent words are lowercase (sentence case)`)
  }

  console.log('=== RULE-09: a11y (aria-labels, focus visibility) ===')
  const mainJs = await readFile(`${PLUGIN_OUT}/main.js`, 'utf8')
  assert(mainJs.includes('aria-label'), 'aria-label used in rendered output')
  assert(/setAttr\(['"]tabindex['"]/.test(mainJs) || /tabindex/.test(mainJs), 'tabindex set on focusable items (cards)')
  assert(/setAttr\(['"]role['"]/.test(mainJs) || /role:/.test(mainJs) || /'role'/.test(mainJs), 'ARIA roles set on board structure')
  assert(/focus-visible/.test(styles), 'focus-visible styles defined')

  console.log('\n✅ All RULE-02..09 audits passed.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
