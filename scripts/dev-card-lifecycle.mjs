#!/usr/bin/env node
// Dev helper: drives a card through create → move → update → delete
// against a live MCP, with a 500ms pause between steps so you can watch
// the open Obsidian board react in real time via SSE.
//
// Usage:
//   node scripts/dev-card-lifecycle.mjs --token <bearer> [--project P]
//                                       [--title T] [--url U]
//                                       [--from-status backlog]
//                                       [--to-status todo]

const args = process.argv.slice(2)
const opts = {
  url: 'http://127.0.0.1:3000',
  title: `lifecycle ${new Date().toISOString().slice(11, 19)}`,
  fromStatus: 'backlog',
  toStatus: 'todo',
}
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--token') opts.token = args[++i]
  else if (a === '--title') opts.title = args[++i]
  else if (a === '--project') opts.project = args[++i]
  else if (a === '--from-status') opts.fromStatus = args[++i]
  else if (a === '--to-status') opts.toStatus = args[++i]
  else if (a === '--url') opts.url = args[++i]
  else if (a === '--help' || a === '-h') {
    console.log(
      'Usage: node scripts/dev-card-lifecycle.mjs --token <bearer> [--project P] [--title T] [--from-status S] [--to-status S] [--url U]',
    )
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const STEP_DELAY_MS = 500

async function call(tool, body) {
  const res = await fetch(`${opts.url}/mcp/tool/${tool}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text }
  return { status: res.status, body: parsed }
}

function fail(step, res) {
  console.error(`[${step}] failed (status ${res.status}):`)
  console.error(JSON.stringify(res.body, null, 2))
  process.exit(1)
}

const tokenFields = { input_tokens: 0, output_tokens: 0, model: 'dev-lifecycle' }

async function main() {
  console.log(`▶ CREATE  title="${opts.title}" status=${opts.fromStatus}`)
  const createBody = { title: opts.title, type: 'task', status: opts.fromStatus, ...tokenFields }
  if (opts.project) createBody.project = opts.project
  const created = await call('kanban_create_card', createBody)
  if (created.status !== 200) fail('CREATE', created)
  const id = created.body.id
  console.log(`  → id=${id} version=${created.body.version} position=${created.body.position}`)
  await sleep(STEP_DELAY_MS)

  console.log(`▶ MOVE    ${opts.fromStatus} → ${opts.toStatus}`)
  const moved = await call('kanban_move_card', {
    id, version: created.body.version, to_status: opts.toStatus, ...tokenFields,
  })
  if (moved.status !== 200) fail('MOVE', moved)
  console.log(`  → version=${moved.body.version} status=${moved.body.status} position=${moved.body.position}`)
  await sleep(STEP_DELAY_MS)

  console.log(`▶ UPDATE  title + priority=high`)
  const updated = await call('kanban_update_card', {
    id, version: moved.body.version,
    title: `${opts.title} (updated)`, priority: 'high', ...tokenFields,
  })
  if (updated.status !== 200) fail('UPDATE', updated)
  console.log(`  → version=${updated.body.version} title="${updated.body.title}" priority=${updated.body.priority}`)
  await sleep(STEP_DELAY_MS)

  console.log(`▶ DELETE`)
  const deleted = await call('kanban_delete_card', {
    id, version: updated.body.version, ...tokenFields,
  })
  if (deleted.status !== 200) fail('DELETE', deleted)
  console.log(`  → ${JSON.stringify(deleted.body)}`)

  console.log('\n✓ lifecycle complete')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
