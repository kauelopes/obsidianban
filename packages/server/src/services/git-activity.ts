import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { logger } from '../util/logger.js'
import { GIT_CACHE_TTL_MS, GIT_LOG_TIMEOUT_MS } from '../util/constants.js'

const run = promisify(execFile)

interface CacheEntry {
  at: number
  sinceIso: string
  timestamps: number[] | null
}

/**
 * Leitura de commits dos target_repo dos projetos. Commits são sinal de
 * trabalho, não contabilidade: qualquer falha — repo movido, não-git, timeout —
 * vira null para o chamador sinalizar "sem repo", nunca erro. O cache curto
 * existe porque a home consulta a cada load e `git log` toca o disco do repo.
 */
export class GitActivityService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly warned = new Map<string, number>()

  /** Epoch ms de cada commit desde `sinceIso` (não-merge), ou null se o repo não responde. */
  async commitTimestamps(repoPath: string, sinceIso: string): Promise<number[] | null> {
    const cached = this.cache.get(repoPath)
    if (cached && cached.sinceIso === sinceIso && Date.now() - cached.at < GIT_CACHE_TTL_MS) {
      return cached.timestamps
    }

    let timestamps: number[] | null
    try {
      const { stdout } = await run(
        'git',
        ['-C', repoPath, 'log', `--since=${sinceIso}`, '--pretty=%ct', '--no-merges'],
        { timeout: GIT_LOG_TIMEOUT_MS },
      )
      timestamps = stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => Number(line) * 1000)
        .filter(Number.isFinite)
    } catch (err) {
      timestamps = null
      const last = this.warned.get(repoPath) ?? 0
      if (Date.now() - last > GIT_CACHE_TTL_MS) {
        this.warned.set(repoPath, Date.now())
        logger.warn({ repoPath, err: String(err) }, 'git log indisponível para target_repo')
      }
    }

    this.cache.set(repoPath, { at: Date.now(), sinceIso, timestamps })
    return timestamps
  }
}
