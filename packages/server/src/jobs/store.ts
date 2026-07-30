import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import { logger } from '../util/logger.js'
import type { JobView } from '@obsidiankan/types'

/**
 * Forma persistida de um job — igual a `JobView` menos `stalled`, que é
 * sempre computado ao vivo pelo JobManager (nunca gravado em disco).
 */
export type JobRecord = Omit<JobView, 'stalled'>

const JOB_ID_RE = /^job-[0-9A-Za-z]{8}$/

/**
 * Persistência de jobs duráveis de longa duração em
 * .kanban/jobs/<job_id>.json — um arquivo por job, escrita atômica (.tmp →
 * rename), mesma disciplina de `PlanningSessionStore`.
 */
export class JobStore {
  private readonly dir: string

  constructor(paths: Paths) {
    this.dir = path.join(paths.kanbanInternal, 'jobs')
  }

  get baseDir(): string {
    return this.dir
  }

  async save(job: JobRecord): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true })
    const file = path.join(this.dir, `${job.job_id}.json`)
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(job, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, file)
  }

  async load(jobId: string): Promise<JobRecord | null> {
    if (!JOB_ID_RE.test(jobId)) return null
    try {
      const raw = await fs.readFile(path.join(this.dir, `${jobId}.json`), 'utf8')
      return JSON.parse(raw) as JobRecord
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, jobId }, 'jobs: failed to load job')
      }
      return null
    }
  }

  async list(): Promise<JobRecord[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err }, 'jobs: failed to list jobs')
      }
      return []
    }
    const out: JobRecord[] = []
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const job = await this.load(name.slice(0, -'.json'.length))
      if (job) out.push(job)
    }
    return out
  }

  async listByCard(cardId: string): Promise<JobRecord[]> {
    const all = await this.list()
    return all.filter((j) => j.card_id === cardId)
  }

  async listRunning(): Promise<JobRecord[]> {
    const all = await this.list()
    return all.filter((j) => j.status === 'running')
  }
}
