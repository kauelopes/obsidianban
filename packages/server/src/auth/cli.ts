#!/usr/bin/env node
import { loadConfig } from '../config.js'
import { ensureLayout } from '../vault/layout.js'
import {
  createAgentToken,
  createManagerToken,
  listAgentTokens,
  listManagerTokens,
  revokeAgentToken,
  revokeManagerToken,
} from './tokens.js'

const USAGE = `kanban-token <command> [options]

Commands:
  create --project P --role agent --actor A
  create --role manager --actor A
  list   --project P
  list   --manager
  revoke --project P --token-id ID
  revoke --manager --token-id ID

VAULT_PATH must be set in the environment.`

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`)
  return i < 0 ? undefined : argv[i + 1]
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`)
}

function die(msg: string): never {
  console.error(msg)
  process.exit(1)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]
  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE)
    process.exit(command ? 0 : 1)
  }

  const config = loadConfig()
  await ensureLayout(config.paths)
  const { paths } = config

  switch (command) {
    case 'create': {
      const role = flag(argv, 'role')
      const actor = flag(argv, 'actor')
      if (!role || !actor) die('create requires --role and --actor')
      if (role === 'agent') {
        const project = flag(argv, 'project')
        if (!project) die('agent create requires --project')
        const issued = await createAgentToken(paths, project, actor)
        console.log(`token_id: ${issued.token_id}`)
        console.log(`actor:    ${issued.actor}`)
        console.log(`project:  ${project}`)
        console.log(`token:    ${issued.raw}`)
        console.log('\nStore the token now — it cannot be recovered later.')
      } else if (role === 'manager') {
        const issued = await createManagerToken(paths, actor)
        console.log(`token_id: ${issued.token_id}`)
        console.log(`actor:    ${issued.actor}`)
        console.log(`role:     manager`)
        console.log(`token:    ${issued.raw}`)
        console.log('\nStore the token now — it cannot be recovered later.')
      } else {
        die(`unknown role: ${role}`)
      }
      break
    }
    case 'list': {
      if (hasFlag(argv, 'manager')) {
        const items = await listManagerTokens(paths)
        for (const t of items) console.log(JSON.stringify({ ...t, role: 'manager' }))
        if (items.length === 0) console.log('(no manager tokens)')
      } else {
        const project = flag(argv, 'project')
        if (!project) die('list requires --project or --manager')
        const items = await listAgentTokens(paths, project)
        for (const t of items) console.log(JSON.stringify({ ...t, role: 'agent', project }))
        if (items.length === 0) console.log(`(no agent tokens for ${project})`)
      }
      break
    }
    case 'revoke': {
      const tokenId = flag(argv, 'token-id')
      if (!tokenId) die('revoke requires --token-id')
      if (hasFlag(argv, 'manager')) {
        const ok = await revokeManagerToken(paths, tokenId)
        if (!ok) die(`manager token ${tokenId} not found or already revoked`)
        console.log(`revoked manager token ${tokenId}`)
      } else {
        const project = flag(argv, 'project')
        if (!project) die('revoke requires --project or --manager')
        const ok = await revokeAgentToken(paths, project, tokenId)
        if (!ok) die(`agent token ${tokenId} not found or already revoked`)
        console.log(`revoked agent token ${tokenId} (project=${project})`)
      }
      break
    }
    default:
      die(`unknown command: ${command}\n\n${USAGE}`)
  }
}

main().catch((err) => {
  console.error('[error]', err.message ?? err)
  process.exit(1)
})
