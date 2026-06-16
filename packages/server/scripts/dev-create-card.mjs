#!/usr/bin/env node
// Dev helper: create a card via the MCP HTTP API. Useful for verifying
// that an open Obsidian board receives the matching SSE event.
//
// Usage:
//   node scripts/dev-create-card.mjs --token <bearer> [--title "Card title"]
//                                    [--project P] [--status backlog]
//                                    [--url http://127.0.0.1:9375]
//
// Token may also come from KANBAN_MCP_TOKEN env. Project may come from
// KANBAN_MCP_PROJECT env (required for manager tokens).

const args = process.argv.slice(2)
const opts = { url: 'http://127.0.0.1:9375', title: `dev card ${new Date().toISOString().slice(11, 19)}` }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--token') opts.token = args[++i]
  else if (a === '--title') opts.title = args[++i]
  else if (a === '--project') opts.project = args[++i]
  else if (a === '--status') opts.status = args[++i]
  else if (a === '--url') opts.url = args[++i]
  else if (a === '--help' || a === '-h') {
    console.log('Usage: node scripts/dev-create-card.mjs --token <bearer> [--title T] [--project P] [--status S] [--url U]')
    process.exit(0)
  } else {
    console.error(`unknown arg: ${a}`)
    process.exit(2)
  }
}
opts.token ??= process.env.KANBAN_MCP_TOKEN
opts.project ??= process.env.KANBAN_MCP_PROJECT
if (!opts.token) {
  console.error('error: --token (or KANBAN_MCP_TOKEN) required')
  process.exit(2)
}

const body = {
  title: opts.title,
  type: 'task',
  input_tokens: 0,
  output_tokens: 0,
  model: 'dev-script',
}
if (opts.project) body.project = opts.project
if (opts.status) body.status = opts.status

const res = await fetch(`${opts.url}/mcp/tool/kanban_create_card`, {
  method: 'POST',
  headers: {
    'authorization': `Bearer ${opts.token}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify(body),
})
const text = await res.text()
let parsed
try { parsed = JSON.parse(text) } catch { parsed = text }

console.log(`status: ${res.status}`)
console.log(JSON.stringify(parsed, null, 2))

if (res.status !== 200) process.exit(1)
