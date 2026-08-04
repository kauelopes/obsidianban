import { describe, expect, it, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { TerminalUsageService } from '../../src/services/terminal-usage.js'
import { createTestDb } from '../helpers/db.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { saveProjectMeta } from '../../src/vault/layout.js'
import type { Paths } from '../../src/config.js'

/**
 * Fixture sintética no formato real dos `.jsonl` do Claude Code (ver
 * `~/.claude/projects/<slug>/<session>.jsonl`): um registro assistant válido
 * por linha, mais um tipo não-assistant (deve ser ignorado) e uma linha
 * corrompida (deve ser pulada sem derrubar o resto do scan).
 */
function assistantLine(opts: {
  sessionId: string
  ts: string
  model: string
  cwd: string
  input: number
  output: number
  cacheRead?: number
  cache5m?: number
  cache1h?: number
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    gitBranch: 'main',
    message: {
      model: opts.model,
      usage: {
        input_tokens: opts.input,
        output_tokens: opts.output,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: (opts.cache5m ?? 0) + (opts.cache1h ?? 0),
        cache_creation: {
          ephemeral_5m_input_tokens: opts.cache5m ?? 0,
          ephemeral_1h_input_tokens: opts.cache1h ?? 0,
        },
      },
    },
  })
}

let claudeProjectsDir: string
let paths: Paths

afterEach(async () => {
  if (claudeProjectsDir) await fs.rm(claudeProjectsDir, { recursive: true, force: true })
  if (paths) await cleanupVault(paths)
})

describe('TerminalUsageService', () => {
  it('ingere só registros assistant, resolve projeto por prefixo de cwd e estima custo', async () => {
    claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-claude-projects-'))
    const sessionDir = path.join(claudeProjectsDir, '-home-kaue-repo')
    await fs.mkdir(sessionDir, { recursive: true })

    paths = await createTempVault()
    const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-repo-'))
    const meta = await setupTestProject(paths, 'alfa')
    await saveProjectMeta(paths, 'alfa', { ...meta, target_repo: repoDir })

    const lines = [
      assistantLine({
        sessionId: 'sess-1',
        ts: '2026-08-01T10:00:00.000Z',
        model: 'claude-sonnet-5',
        cwd: repoDir,
        input: 100,
        output: 50,
        cacheRead: 1000,
        cache1h: 200,
      }),
      JSON.stringify({ type: 'human', timestamp: '2026-08-01T10:00:01.000Z' }),
      assistantLine({
        sessionId: 'sess-1',
        ts: '2026-08-01T10:00:02.000Z',
        model: 'claude-opus-4-8',
        cwd: '/nao/e/um/repo/conhecido',
        input: 10,
        output: 5,
      }),
      '{not valid json',
    ]
    const filePath = path.join(sessionDir, 'sess-1.jsonl')
    await fs.writeFile(filePath, lines.join('\n') + '\n', 'utf8')

    const db = createTestDb()
    const service = new TerminalUsageService(db, paths, claudeProjectsDir)
    await service.ensureFresh()

    const rows = db.prepare(`SELECT * FROM terminal_usage ORDER BY ts`).all() as Array<{
      project: string | null
      model: string
      cost_usd: number
      cache_read_tokens: number
      cache_1h_tokens: number
    }>
    expect(rows).toHaveLength(2)
    expect(rows[0]!.project).toBe('alfa')
    expect(rows[0]!.model).toBe('claude-sonnet-5')
    expect(rows[0]!.cost_usd).toBeGreaterThan(0)
    expect(rows[0]!.cache_read_tokens).toBe(1000)
    expect(rows[0]!.cache_1h_tokens).toBe(200)
    expect(rows[1]!.project).toBeNull()

    const progress = db
      .prepare(`SELECT byte_offset FROM terminal_scan_progress WHERE source_file = ?`)
      .get('-home-kaue-repo/sess-1.jsonl') as { byte_offset: number } | undefined
    expect(progress?.byte_offset).toBe(Buffer.byteLength(lines.join('\n') + '\n', 'utf8'))

    await fs.rm(repoDir, { recursive: true, force: true })
  })

  it('scan incremental: uma segunda rodada só processa o que foi anexado desde o offset salvo', async () => {
    claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-claude-projects-'))
    const sessionDir = path.join(claudeProjectsDir, 'proj')
    await fs.mkdir(sessionDir, { recursive: true })
    paths = await createTempVault()

    const filePath = path.join(sessionDir, 'sess-2.jsonl')
    const first = assistantLine({
      sessionId: 'sess-2',
      ts: '2026-08-01T10:00:00.000Z',
      model: 'claude-haiku-4-5',
      cwd: '/x',
      input: 10,
      output: 5,
    })
    await fs.writeFile(filePath, first + '\n', 'utf8')

    const db = createTestDb()
    await new TerminalUsageService(db, paths, claudeProjectsDir).ensureFresh()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM terminal_usage`).get()).toEqual({ n: 1 })

    const second = assistantLine({
      sessionId: 'sess-2',
      ts: '2026-08-01T10:05:00.000Z',
      model: 'claude-haiku-4-5',
      cwd: '/x',
      input: 20,
      output: 8,
    })
    await fs.appendFile(filePath, second + '\n', 'utf8')

    // Nova instância = TTL zerado, mas o offset persiste no banco: só a
    // linha nova deve ser processada, não um re-scan do arquivo inteiro.
    await new TerminalUsageService(db, paths, claudeProjectsDir).ensureFresh()
    const rows = db.prepare(`SELECT ts FROM terminal_usage ORDER BY ts`).all() as Array<{ ts: string }>
    expect(rows.map((r) => r.ts)).toEqual(['2026-08-01T10:00:00.000Z', '2026-08-01T10:05:00.000Z'])
  })

  it('projeto sem target_repo (ou diretório inexistente) não quebra o scan', async () => {
    claudeProjectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-claude-projects-empty-'))
    paths = await createTempVault()
    const db = createTestDb()
    await expect(new TerminalUsageService(db, paths, claudeProjectsDir).ensureFresh()).resolves.toBeUndefined()
    expect(db.prepare(`SELECT COUNT(*) AS n FROM terminal_usage`).get()).toEqual({ n: 0 })
  })

  it('diretório de sessões ausente é tratado como "nada a escanear", não erro', async () => {
    paths = await createTempVault()
    const db = createTestDb()
    const missingDir = path.join(os.tmpdir(), 'obsidiankan-claude-projects-does-not-exist')
    await expect(new TerminalUsageService(db, paths, missingDir).ensureFresh()).resolves.toBeUndefined()
  })
})
