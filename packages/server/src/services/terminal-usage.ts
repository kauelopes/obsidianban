import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type Database from 'better-sqlite3'
import { estimateUsd } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { listProjectsSafe, loadProjectMetaOrNull } from '../vault/layout.js'
import { readLogSlice } from '../util/log-file.js'
import { logger } from '../util/logger.js'
import {
  GIT_LOG_TIMEOUT_MS,
  TERMINAL_PROJECTS_CACHE_TTL_MS,
  TERMINAL_SCAN_MAX_BYTES_PER_ROUND,
  TERMINAL_USAGE_TTL_MS,
} from '../util/constants.js'

const run = promisify(execFile)

interface ProjectPrefixes {
  project: string
  prefixes: string[]
}

interface TerminalUsageRow {
  session_id: string
  project: string | null
  ts: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  cache_5m_tokens: number
  cache_1h_tokens: number
  cost_usd: number
  cwd: string | null
  git_branch: string | null
  source_file: string
}

/**
 * Ingestão incremental dos `.jsonl` de sessão do Claude Code em
 * `~/.claude/projects/` para a tabela `terminal_usage` (Fase 1 do plano de
 * visibilidade de uso — ver memória `project-terminal-usage-plan`). Só o
 * usage por registro assistant é extraído (poucos KB por sessão); o conteúdo
 * das conversas nunca é lido para além disso, nem persistido.
 *
 * Scan por offset (nunca reprocessa o arquivo inteiro), pull sob demanda com
 * TTL — chamado por `ensureFresh()` no handler de GET /metrics, sem watcher.
 */
export class TerminalUsageService {
  private lastScanAt = 0
  private prefixCache: { at: number; prefixes: ProjectPrefixes[] } | null = null

  constructor(
    private readonly db: Database.Database,
    private readonly paths: Paths,
    private readonly claudeProjectsDir: string = path.join(os.homedir(), '.claude', 'projects'),
  ) {}

  /** Reprocessa arquivos alterados se o TTL expirou; sem watcher, sem scan no boot. */
  async ensureFresh(): Promise<void> {
    const now = Date.now()
    if (now - this.lastScanAt < TERMINAL_USAGE_TTL_MS) return
    this.lastScanAt = now
    await this.scanAll()
  }

  private async scanAll(): Promise<void> {
    let dirs: string[]
    try {
      dirs = await fs.readdir(this.claudeProjectsDir)
    } catch (err) {
      logger.warn(
        { err: String(err), dir: this.claudeProjectsDir },
        'terminal-usage: não foi possível listar sessões do terminal',
      )
      return
    }

    const prefixes = await this.buildProjectPrefixes()
    // Orçamento da rodada inteira, não por arquivo: com uma sessão por arquivo,
    // um cap por arquivo deixaria o primeiro GET /metrics ler o backlog todo.
    let budget = TERMINAL_SCAN_MAX_BYTES_PER_ROUND

    for (const dir of dirs) {
      if (budget <= 0) break
      const dirPath = path.join(this.claudeProjectsDir, dir)
      let entries: string[]
      try {
        const stat = await fs.stat(dirPath)
        if (!stat.isDirectory()) continue
        entries = await fs.readdir(dirPath)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (budget <= 0) break
        if (!entry.endsWith('.jsonl')) continue
        const filePath = path.join(dirPath, entry)
        const sourceKey = `${dir}/${entry}`
        const consumed = await this.scanFile(filePath, sourceKey, prefixes, budget).catch((err) => {
          logger.warn({ err: String(err), sourceKey }, 'terminal-usage: falha ao escanear sessão')
          return 0
        })
        budget -= consumed
      }
    }

    if (budget <= 0) {
      logger.info('terminal-usage: orçamento da rodada esgotado — backlog continua no próximo scan')
    }
  }

  /** Retorna quantos bytes consumiu do orçamento da rodada. */
  private async scanFile(
    filePath: string,
    sourceKey: string,
    prefixes: ProjectPrefixes[],
    budget: number,
  ): Promise<number> {
    const offset = this.getOffset(sourceKey)
    const slice = await readLogSlice(filePath, offset, budget)
    if (!slice || slice.size <= offset) return 0

    // jsonl é append-only; só avançamos o offset até o último `\n` completo,
    // pra nunca partir uma linha em progresso de escrita ao meio.
    const lastNewline = slice.data.lastIndexOf('\n')
    if (lastNewline < 0) return 0
    const chunk = slice.data.slice(0, lastNewline)
    const consumedBytes = Buffer.byteLength(slice.data.slice(0, lastNewline + 1), 'utf8')

    const rows = this.parseLines(chunk, sourceKey, prefixes)
    this.insertRows(rows)
    this.setOffset(sourceKey, offset + consumedBytes)
    return consumedBytes
  }

  private parseLines(chunk: string, sourceKey: string, prefixes: ProjectPrefixes[]): TerminalUsageRow[] {
    const rows: TerminalUsageRow[] = []
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line) as Record<string, unknown>
      } catch (err) {
        logger.warn({ err: String(err), sourceKey }, 'terminal-usage: linha inválida no jsonl — pulando')
        continue
      }
      if (rec['type'] !== 'assistant') continue
      const timestamp = rec['timestamp']
      const message = rec['message'] as Record<string, unknown> | undefined
      const usage = message?.['usage'] as Record<string, unknown> | undefined
      if (typeof timestamp !== 'string' || !usage) continue

      const model = typeof message?.['model'] === 'string' ? (message['model'] as string) : 'unknown'
      const sessionId =
        typeof rec['sessionId'] === 'string'
          ? (rec['sessionId'] as string)
          : typeof rec['session_id'] === 'string'
            ? (rec['session_id'] as string)
            : 'unknown'
      const cwd = typeof rec['cwd'] === 'string' ? (rec['cwd'] as string) : null
      const gitBranch = typeof rec['gitBranch'] === 'string' ? (rec['gitBranch'] as string) : null

      const inputTokens = numberOr(usage['input_tokens'], 0)
      const outputTokens = numberOr(usage['output_tokens'], 0)
      const cacheRead = numberOr(usage['cache_read_input_tokens'], 0)
      const cacheCreation = numberOr(usage['cache_creation_input_tokens'], 0)
      const cacheCreationBlock = usage['cache_creation'] as Record<string, unknown> | undefined
      const cache5m = numberOr(cacheCreationBlock?.['ephemeral_5m_input_tokens'], 0)
      const cache1h = numberOr(cacheCreationBlock?.['ephemeral_1h_input_tokens'], 0)

      // Registros sem o bloco `cache_creation` (sessões mais antigas) só trazem
      // o total em cache_creation_input_tokens — contá-lo como 5m (o TTL padrão)
      // em vez de zerar, senão o write, maior fatia do custo, sai como US$ 0.
      const hasBreakdown = cache5m + cache1h > 0
      const creation5m = hasBreakdown ? cache5m : cacheCreation

      const cost =
        estimateUsd(model, inputTokens, outputTokens, {
          readTokens: cacheRead,
          creationTokens: creation5m,
          creation1hTokens: cache1h,
        }) ?? 0

      rows.push({
        session_id: sessionId,
        project: resolveProject(cwd, prefixes),
        ts: timestamp,
        model,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        cache_creation_tokens: hasBreakdown ? cache5m + cache1h : cacheCreation,
        cache_5m_tokens: cache5m,
        cache_1h_tokens: cache1h,
        cost_usd: cost,
        cwd,
        git_branch: gitBranch,
        source_file: sourceKey,
      })
    }
    return rows
  }

  private insertRows(rows: TerminalUsageRow[]): void {
    if (rows.length === 0) return
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO terminal_usage
         (session_id, project, ts, model, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, cache_5m_tokens, cache_1h_tokens,
          cost_usd, cwd, git_branch, source_file)
       VALUES
         (@session_id, @project, @ts, @model, @input_tokens, @output_tokens,
          @cache_read_tokens, @cache_creation_tokens, @cache_5m_tokens, @cache_1h_tokens,
          @cost_usd, @cwd, @git_branch, @source_file)`,
    )
    const insertAll = this.db.transaction((entries: TerminalUsageRow[]) => {
      for (const entry of entries) stmt.run(entry)
    })
    insertAll(rows)
  }

  private getOffset(sourceFile: string): number {
    const row = this.db
      .prepare(`SELECT byte_offset FROM terminal_scan_progress WHERE source_file = ?`)
      .get(sourceFile) as { byte_offset: number } | undefined
    return row?.byte_offset ?? 0
  }

  private setOffset(sourceFile: string, byteOffset: number): void {
    this.db
      .prepare(
        `INSERT INTO terminal_scan_progress (source_file, byte_offset, updated_at)
         VALUES (@source_file, @byte_offset, @updated_at)
         ON CONFLICT(source_file) DO UPDATE SET byte_offset = @byte_offset, updated_at = @updated_at`,
      )
      .run({ source_file: sourceFile, byte_offset: byteOffset, updated_at: new Date().toISOString() })
  }

  /** target_repo + `git worktree list` de cada projeto, cacheado com TTL. */
  private async buildProjectPrefixes(): Promise<ProjectPrefixes[]> {
    if (this.prefixCache && Date.now() - this.prefixCache.at < TERMINAL_PROJECTS_CACHE_TTL_MS) {
      return this.prefixCache.prefixes
    }

    const result: ProjectPrefixes[] = []
    const projects = await listProjectsSafe(this.paths)
    for (const project of projects) {
      const meta = await loadProjectMetaOrNull(this.paths, project)
      const repo = meta?.target_repo
      if (!repo) continue
      const prefixes = [repo]
      try {
        const { stdout } = await run('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          timeout: GIT_LOG_TIMEOUT_MS,
        })
        for (const line of stdout.split('\n')) {
          if (!line.startsWith('worktree ')) continue
          const worktree = line.slice('worktree '.length).trim()
          if (worktree && worktree !== repo) prefixes.push(worktree)
        }
      } catch (err) {
        logger.warn({ err: String(err), project, repo }, 'terminal-usage: git worktree list indisponível')
      }
      result.push({ project, prefixes })
    }

    this.prefixCache = { at: Date.now(), prefixes: result }
    return result
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function resolveProject(cwd: string | null, prefixes: ProjectPrefixes[]): string | null {
  if (!cwd) return null
  for (const { project, prefixes: pfx } of prefixes) {
    for (const prefix of pfx) {
      if (cwd === prefix || cwd.startsWith(prefix + path.sep)) return project
    }
  }
  return null
}
