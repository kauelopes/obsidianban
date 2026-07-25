import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AdminService } from '../../src/services/admin.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'

const SKILL_FILES = [
  'kanban-dev-agent/SKILL.md',
  'kanban-dev-agent/reference/protocol.md',
  'kanban-pm-agent/SKILL.md',
  'kanban-pm-agent/spawn-dev.sh',
  'kanban-pm-agent/dev.mcp.json',
  'kanban-pm-agent/dev-settings.json',
  'kanban-pm-agent/reference/protocol.md',
  'kanban-manager-agent/SKILL.md',
  'kanban-manager-agent/reference/protocol.md',
]

let paths: Paths
let admin: AdminService
let targetRepo: string
let skillsSource: string
let previousSkillsSource: string | undefined

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  admin = new AdminService(
    paths,
    createTestRepo(db),
    new AuditLogger(paths.auditLog),
    new SSEEventBus(),
  )

  targetRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-repo-'))
  skillsSource = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-skills-'))
  for (const rel of SKILL_FILES) {
    const dest = path.join(skillsSource, rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.writeFile(dest, `# ${rel}\n`, 'utf8')
  }
  previousSkillsSource = process.env['OBSIDIANKAN_SKILLS_SOURCE']
  process.env['OBSIDIANKAN_SKILLS_SOURCE'] = skillsSource
})

afterEach(async () => {
  if (previousSkillsSource === undefined) delete process.env['OBSIDIANKAN_SKILLS_SOURCE']
  else process.env['OBSIDIANKAN_SKILLS_SOURCE'] = previousSkillsSource
  await cleanupVault(paths)
  await fs.rm(targetRepo, { recursive: true, force: true })
  await fs.rm(skillsSource, { recursive: true, force: true })
})

describe('kanban_create_project com target_repo', () => {
  it('provisiona o ambiente do workflow na mesma chamada', async () => {
    const res = await admin.createProject(
      { project: 'novo', actor: 'human:kaue', target_repo: targetRepo },
      makeManagerClaims(),
    )

    expect(res.workflow_readiness).toBeDefined()
    const r = res.workflow_readiness!
    expect(r.repo_exists).toBe(true)
    // Nenhuma skill estava presente, então todas têm de ter sido instaladas.
    expect(r.skills.every((s) => s.installed)).toBe(true)
    expect(r.tokens.generated_pm?.agent_type).toBe('pm')
    expect(r.tokens.generated_dev?.agent_type).toBe('dev')
  })

  it('os arquivos chegam ao disco do repo alvo', async () => {
    await admin.createProject(
      { project: 'novo', actor: 'human:kaue', target_repo: targetRepo },
      makeManagerClaims(),
    )

    for (const rel of SKILL_FILES) {
      await expect(
        fs.stat(path.join(targetRepo, '.claude', 'skills', rel)),
        `skill ausente: ${rel}`,
      ).resolves.toBeDefined()
    }
    const mcpJson = await fs.readFile(path.join(targetRepo, '.claude', 'mcp.json'), 'utf8')
    expect(mcpJson).toContain('/mcp')

    // Os tokens do workflow precisam estar legíveis em settings.local.json — é
    // de lá que o harness do dev os lê.
    const settings = JSON.parse(
      await fs.readFile(path.join(targetRepo, '.claude', 'settings.local.json'), 'utf8'),
    ) as { env: Record<string, string> }
    expect(settings.env['KANBAN_TOKEN']).toBeTruthy()
    expect(settings.env['KANBAN_DEV_TOKEN']).toBeTruthy()
  })

  it('grava o target_repo no meta do projeto', async () => {
    await admin.createProject(
      { project: 'novo', actor: 'human:kaue', target_repo: targetRepo },
      makeManagerClaims(),
    )
    const meta = JSON.parse(
      await fs.readFile(path.join(paths.kanbanData, 'novo', '_meta.json'), 'utf8'),
    ) as { target_repo?: string }
    expect(meta.target_repo).toBe(targetRepo)
  })

  it('sem target_repo não provisiona nada e não devolve relatório', async () => {
    const res = await admin.createProject(
      { project: 'seco', actor: 'human:kaue' },
      makeManagerClaims(),
    )
    expect(res.workflow_readiness).toBeUndefined()
    expect(res.token).toBeTruthy()
    await expect(fs.stat(path.join(targetRepo, '.claude'))).rejects.toThrow()
  })

  it('repo inexistente não derruba a criação — o projeto nasce e o relatório aponta o problema', async () => {
    const res = await admin.createProject(
      { project: 'torto', actor: 'human:kaue', target_repo: '/nao/existe/em/lugar/nenhum' },
      makeManagerClaims(),
    )
    expect(res.project).toBe('torto')
    expect(res.workflow_readiness?.repo_exists).toBe(false)
  })
})
