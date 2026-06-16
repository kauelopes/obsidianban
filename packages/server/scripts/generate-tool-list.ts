/**
 * Regenerates docs/tool_list.md from TOOL_CATALOG (the single source of truth
 * in src/server/tool-catalog.ts). Run with: npm run gen:tools
 *
 * Do not edit docs/tool_list.md by hand — change the descriptions in
 * tool-catalog.ts and rerun this script.
 */
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { TOOL_CATALOG, type ToolCategory, type ToolMeta } from '../src/server/tool-catalog.ts'

const CATEGORY_ORDER: ToolCategory[] = ['Cards', 'Workflow', 'Projetos', 'Auth', 'Sprints']

/** Escape characters that would break a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function devCheck(access: ToolMeta['access']): string {
  return access === 'all' ? '✓' : ''
}

function pmCheck(access: ToolMeta['access']): string {
  return access === 'all' || access === 'pm' ? '✓' : ''
}

function renderCategory(category: ToolCategory): string {
  const tools = TOOL_CATALOG.filter((t) => t.category === category)
  const lines = [
    `## ${category} (${tools.length} ${tools.length === 1 ? 'tool' : 'tools'})`,
    '',
    '| Tool | Description | Dev | PM |',
    '|------|-------------|:---:|:--:|',
  ]
  for (const t of tools) {
    lines.push(`| \`${t.name}\` | ${cell(t.description)} | ${devCheck(t.access)} | ${pmCheck(t.access)} |`)
  }
  return lines.join('\n')
}

function render(): string {
  const sections = CATEGORY_ORDER.map(renderCategory).join('\n\n')
  return [
    '# Kanban MCP — Tool List',
    '',
    '> Generated from `src/server/tool-catalog.ts` by `npm run gen:tools`. Do not edit by hand.',
    '>',
    '> Access levels: **Dev** and **PM** are agent token types. Tools with no check in either column are **manager-only**. Each agent only receives the tools it can call — the list is filtered by token type at connection time.',
    '',
    '---',
    '',
    sections,
    '',
  ].join('\n')
}

async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url))
  const outPath = resolve(here, '../docs/tool_list.md')
  await writeFile(outPath, render(), 'utf8')
  console.log(`wrote ${outPath} (${TOOL_CATALOG.length} tools)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
