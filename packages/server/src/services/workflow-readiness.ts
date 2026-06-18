import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import { createAgentToken } from '../auth/tokens.js'
import { loadProjectMetaOrNull } from '../vault/layout.js'
import { logger } from '../util/logger.js'
import type { WorkflowReadinessResult, SkillFileCheck, ConfigFileCheck, GeneratedToken } from '@obsidiankan/types'

const REQUIRED_SKILL_FILES = [
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

function resolveSkillsSource(): string {
  if (process.env['OBSIDIANKAN_SKILLS_SOURCE']) return process.env['OBSIDIANKAN_SKILLS_SOURCE']
  // packages/server/src/services/ → up 4 levels → monorepo root → .claude/skills/
  return path.join(__dirname, '..', '..', '..', '..', '.claude', 'skills')
}

function mcpJsonTemplate(port: number): string {
  return JSON.stringify({
    mcpServers: {
      kanban: {
        type: 'http',
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: 'Bearer ${KANBAN_TOKEN}' },
      },
    },
  }, null, 2) + '\n'
}

async function fileExists(filePath: string): Promise<boolean> {
  return fs.stat(filePath).then(() => true, () => false)
}

async function copySkillFile(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.copyFile(src, dest)
  if (dest.endsWith('.sh')) {
    const stat = await fs.stat(dest)
    await fs.chmod(dest, stat.mode | 0o111)
  }
}

async function validateAndFixMcpUrl(filePath: string, expectedUrl: string): Promise<'ok' | 'fixed' | 'missing'> {
  let content: Record<string, unknown>
  try {
    content = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return 'missing'
  }
  const servers = content['mcpServers'] as Record<string, Record<string, unknown>> | undefined
  const kanban = servers?.['kanban']
  if (!kanban) return 'missing'
  if (kanban['url'] === expectedUrl) return 'ok'
  kanban['url'] = expectedUrl
  await fs.writeFile(filePath, JSON.stringify(content, null, 2) + '\n', 'utf8')
  return 'fixed'
}

async function readSettingsLocal(filePath: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function checkWorkflowReadiness(
  project: string,
  targetRepo: string,
  paths: Paths,
): Promise<WorkflowReadinessResult> {
  const skillsSource = resolveSkillsSource()
  const port = Number(process.env['MCP_HTTP_PORT'] ?? 9375)

  const repoExists = await fileExists(targetRepo)

  // ── Skills ──────────────────────────────────────────────────────────────────
  const skills: SkillFileCheck[] = []
  for (const relPath of REQUIRED_SKILL_FILES) {
    const dest = path.join(targetRepo, '.claude', 'skills', relPath)
    const src = path.join(skillsSource, relPath)
    const was_present = await fileExists(dest)
    let installed = false
    if (!was_present && repoExists) {
      try {
        await copySkillFile(src, dest)
        installed = true
      } catch (err) {
        logger.warn({ err, project, file: relPath }, 'workflow-readiness: failed to install skill file')
      }
    }
    skills.push({ path: relPath, was_present, installed })
  }

  // ── Config files ─────────────────────────────────────────────────────────────
  const config_files: ConfigFileCheck[] = []

  const mcpUrl = `http://127.0.0.1:${port}/mcp`

  const mcpJsonPath = path.join(targetRepo, '.claude', 'mcp.json')
  const mcpJsonPresent = await fileExists(mcpJsonPath)
  let mcpJsonWritten = false
  let mcpJsonDetail: string | undefined
  if (repoExists) {
    if (!mcpJsonPresent) {
      try {
        await fs.mkdir(path.dirname(mcpJsonPath), { recursive: true })
        await fs.writeFile(mcpJsonPath, mcpJsonTemplate(port), 'utf8')
        mcpJsonWritten = true
      } catch (err) {
        logger.warn({ err, project }, 'workflow-readiness: failed to write mcp.json')
      }
    } else {
      const urlCheck = await validateAndFixMcpUrl(mcpJsonPath, mcpUrl)
      if (urlCheck === 'fixed') {
        mcpJsonWritten = true
        mcpJsonDetail = 'url corrected'
        logger.warn({ project, mcpUrl }, 'workflow-readiness: corrected mcp.json url')
      }
    }
  }
  config_files.push({ path: '.claude/mcp.json', was_present: mcpJsonPresent, written: mcpJsonWritten, detail: mcpJsonDetail })

  // dev.mcp.json — installed as a skill file, but its URL must also match the server
  const devMcpPath = path.join(targetRepo, '.claude', 'skills', 'kanban-pm-agent', 'dev.mcp.json')
  let devMcpDetail: string | undefined
  let devMcpUrlFixed = false
  if (repoExists && await fileExists(devMcpPath)) {
    const urlCheck = await validateAndFixMcpUrl(devMcpPath, mcpUrl)
    if (urlCheck === 'fixed') {
      devMcpUrlFixed = true
      devMcpDetail = 'url corrected'
      logger.warn({ project, mcpUrl }, 'workflow-readiness: corrected dev.mcp.json url')
    }
  }
  if (devMcpDetail) {
    config_files.push({ path: '.claude/skills/kanban-pm-agent/dev.mcp.json', was_present: true, written: devMcpUrlFixed, detail: devMcpDetail })
  }

  // ── Tokens ───────────────────────────────────────────────────────────────────
  // "Configured" means the raw value is accessible in settings.local.json, not just hashed in meta.
  const settingsPath = path.join(targetRepo, '.claude', 'settings.local.json')
  const settingsPresent = await fileExists(settingsPath)
  const existing = await readSettingsLocal(settingsPath)
  const existingEnv = (existing['env'] as Record<string, string> | undefined) ?? {}

  const hasPmInSettings = typeof existingEnv['KANBAN_TOKEN'] === 'string' && existingEnv['KANBAN_TOKEN'].length > 0
  const hasDevInSettings = typeof existingEnv['KANBAN_DEV_TOKEN'] === 'string' && existingEnv['KANBAN_DEV_TOKEN'].length > 0

  let generated_pm: GeneratedToken | undefined
  let generated_dev: GeneratedToken | undefined

  if (!hasPmInSettings) {
    const issued = await createAgentToken(paths, project, 'workflow:pm', 'pm')
    generated_pm = { token: issued.raw, token_id: issued.token_id, actor: issued.actor, agent_type: 'pm' }
  }
  if (!hasDevInSettings) {
    const issued = await createAgentToken(paths, project, 'workflow:dev', 'dev')
    generated_dev = { token: issued.raw, token_id: issued.token_id, actor: issued.actor, agent_type: 'dev' }
  }

  let settingsWritten = false
  if (repoExists && (generated_pm !== undefined || generated_dev !== undefined)) {
    try {
      const updated = {
        ...existing,
        env: {
          ...existingEnv,
          ...(generated_pm ? { KANBAN_TOKEN: generated_pm.token } : {}),
          ...(generated_dev ? { KANBAN_DEV_TOKEN: generated_dev.token } : {}),
        },
        enabledMcpjsonServers: (existing['enabledMcpjsonServers'] as string[] | undefined) ?? ['kanban'],
      }
      await fs.mkdir(path.dirname(settingsPath), { recursive: true })
      await fs.writeFile(settingsPath, JSON.stringify(updated, null, 2) + '\n', 'utf8')
      settingsWritten = true
    } catch (err) {
      logger.warn({ err, project }, 'workflow-readiness: failed to write settings.local.json')
    }
  }
  config_files.push({ path: '.claude/settings.local.json', was_present: settingsPresent, written: settingsWritten })

  const skillsAllPresent = skills.every((s) => s.was_present || s.installed)
  const configAllPresent = config_files.every((f) => f.was_present || f.written)
  const all_ok = skillsAllPresent && configAllPresent && hasPmInSettings && hasDevInSettings && repoExists

  const result: WorkflowReadinessResult = {
    target_repo: targetRepo,
    repo_exists: repoExists,
    skills,
    config_files,
    tokens: { has_pm: hasPmInSettings, has_dev: hasDevInSettings, generated_pm, generated_dev },
    all_ok,
  }

  if (all_ok) {
    logger.info({ project, target_repo: targetRepo }, 'workflow-readiness: all ok')
  } else {
    logger.warn({ project, target_repo: targetRepo, result }, 'workflow-readiness: issues found and fixed')
  }

  return result
}
