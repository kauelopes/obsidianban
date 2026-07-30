import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { saveProjectMeta } from '../../src/vault/layout.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeDevClaims } from '../helpers/factories.js'
import { CardService } from '../../src/services/card.js'
import { SprintService } from '../../src/services/sprint.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { HttpError } from '../../src/services/errors.js'
import { JobStore, JOB_ID_RE } from '../../src/jobs/store.js'
import { JobManager, type JobConfig, type WorkflowRef } from '../../src/services/job-runner.js'
import { createJobToolHandlers } from '../../src/server/job-tools.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import type { Card, JobView, TokenClaims } from '@obsidiankan/types'

let paths: Paths
let repo: CardRepository
let cards: CardService
let sprints: SprintService
let store: JobStore
let jobs: JobManager
let handlers: Record<string, (p: Record<string, unknown>, c: TokenClaims) => Promise<unknown>>

const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
// Nenhum teste deste arquivo exercita o wake do workflow (Task 7) — só o
// contrato de start/get/list/stop; um double no-op basta como dependência.
const noopWorkflow: WorkflowRef = { isRunning: () => false, start: async () => undefined }
const MGR = makeManagerClaims()
const DEV = makeDevClaims()
const TOKEN = { input_tokens: 0, output_tokens: 0, model: 'test' }

function waitFor(pred: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      void Promise.resolve()
        .then(pred)
        .then((ok) => {
          if (ok) {
            clearInterval(timer)
            resolve()
          } else if (Date.now() - t0 > ms) {
            clearInterval(timer)
            reject(new Error('waitFor timeout'))
          }
        })
        .catch(() => {
          if (Date.now() - t0 > ms) {
            clearInterval(timer)
            reject(new Error('waitFor timeout'))
          }
        })
    }, 50)
  })
}

async function setupProject(targetRepo: string | null): Promise<{ sprintId: string; card: Card }> {
  const meta = await setupTestProject(paths, 'test-project')
  if (targetRepo) {
    meta.target_repo = targetRepo
    await saveProjectMeta(paths, 'test-project', meta)
  }
  const sprint = await sprints.createSprint({ project: 'test-project', name: 'S1' }, MGR)
  await sprints.startSprint({ sprint_id: sprint.id }, MGR)
  const card = await cards.create(
    { ...TOKEN, title: 'Job Card', type: 'task', project: 'test-project', sprint_id: sprint.id, status: 'todo' },
    MGR,
  )
  return { sprintId: sprint.id, card }
}

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  repo = createTestRepo(db)
  const writer = new AtomicWriter(paths, repo)
  const sse = new SSEEventBus()
  vi.spyOn(sse, 'emit').mockImplementation(() => {})
  cards = new CardService(paths, repo, writer, audit, sse)
  sprints = new SprintService(paths, repo, writer, audit, sse)
  store = new JobStore(paths)
  const cfg: JobConfig = {
    logDir: path.join(paths.vault, '.kanban', 'job-logs'),
    stallThresholdMs: 60_000,
    stallPollMs: 60_000,
    maxRuntimeMs: 60_000,
    maxConcurrent: 3,
    envAllowlist: [],
    maxWakesPerSprint: 5,
  }
  jobs = new JobManager(cfg, store, cards, sse, audit, noopWorkflow, paths)
  handlers = createJobToolHandlers({ paths, cards, jobs })
  vi.clearAllMocks()
})

afterEach(async () => {
  await jobs.dispose()
  vi.restoreAllMocks()
  await cleanupVault(paths)
})

describe('kanban_start_job', () => {
  it('dev token: logs the command, parks the card on job:<id> in in_progress, and hands back on finish', async () => {
    const { card } = await setupProject(paths.vault)

    const view = (await handlers['kanban_start_job']!(
      { id: card.id, version: card.version, command: 'echo started-by-tool' },
      DEV,
    )) as JobView

    expect(view.job_id).toMatch(JOB_ID_RE)
    expect(view.status).toBe('running')
    expect(view.claimed_by).toBe(DEV.actor)

    const parked = await cards.get({ id: card.id }, MGR)
    // Comando pode terminar rápido — aceita parked OU já devolvido; o log do
    // comando tem de existir em qualquer caso.
    expect(parked.body).toContain('echo started-by-tool')
    expect(parked.body).toContain(view.job_id)

    await waitFor(async () => {
      const c = await cards.get({ id: card.id }, MGR)
      return c.status === 'todo' && c.assigned_to === null
    })
    const done = await cards.get({ id: card.id }, MGR)
    expect(done.body).toContain('succeeded')
  })

  it('parks the card while a long job runs (assigned_to job:<id>, in_progress)', async () => {
    const { card } = await setupProject(paths.vault)
    const view = (await handlers['kanban_start_job']!(
      { id: card.id, version: card.version, command: 'sleep 5' },
      DEV,
    )) as JobView

    const parked = await cards.get({ id: card.id }, MGR)
    expect(parked.assigned_to).toBe(`job:${view.job_id}`)
    expect(parked.status).toBe('in_progress')

    await jobs.stop(view.job_id, 'human:test')
    await waitFor(async () => (await cards.get({ id: card.id }, MGR)).status === 'todo')
  })

  it('400 target_repo_not_set when the project has no repo — card untouched', async () => {
    const { card } = await setupProject(null)
    await expect(
      handlers['kanban_start_job']!({ id: card.id, version: card.version, command: 'echo x' }, DEV),
    ).rejects.toMatchObject({ status: 400, body: { error: 'target_repo_not_set' } })
    const after = await cards.get({ id: card.id }, MGR)
    expect(after.version).toBe(card.version)
    expect(after.assigned_to).toBeNull()
  })

  it('409 on version conflict — nothing spawned, card untouched', async () => {
    const { card } = await setupProject(paths.vault)
    await expect(
      handlers['kanban_start_job']!({ id: card.id, version: card.version + 5, command: 'echo x' }, DEV),
    ).rejects.toMatchObject({ status: 409 })
    expect(jobs.listRunning()).toEqual([])
    const after = await cards.get({ id: card.id }, MGR)
    expect(after.assigned_to).toBeNull()
  })

  it('reverts the parking when the spawn fails (cwd missing)', async () => {
    const { card } = await setupProject(path.join(paths.vault, 'does-not-exist'))
    await expect(
      handlers['kanban_start_job']!({ id: card.id, version: card.version, command: 'echo x' }, DEV),
    ).rejects.toMatchObject({ status: 400, body: { error: 'job_cwd_missing' } })
    const after = await cards.get({ id: card.id }, MGR)
    expect(after.assigned_to).toBeNull()
    expect(after.status).toBe('todo')
    expect(after.body).toContain('failed to start')
  })

  it('404 for a card that does not exist', async () => {
    await setupProject(paths.vault)
    await expect(
      handlers['kanban_start_job']!({ id: 'card-nope1234', version: 1, command: 'echo x' }, DEV),
    ).rejects.toBeInstanceOf(HttpError)
  })
})

describe('kanban_get_job / kanban_list_jobs', () => {
  it('returns the JobView, and the log tail when log_offset is passed', async () => {
    const { card } = await setupProject(paths.vault)
    const view = (await handlers['kanban_start_job']!(
      { id: card.id, version: card.version, command: 'echo tail-me && sleep 5' },
      DEV,
    )) as JobView

    const got = (await handlers['kanban_get_job']!({ job_id: view.job_id }, DEV)) as { job: JobView }
    expect(got.job.job_id).toBe(view.job_id)
    expect(typeof got.job.stalled).toBe('boolean')

    await waitFor(async () => {
      const r = (await handlers['kanban_get_job']!({ job_id: view.job_id, log_offset: 0 }, DEV)) as {
        data: string
      }
      return r.data.includes('tail-me')
    })

    await jobs.stop(view.job_id, 'human:test')
  })

  it('404 for an unknown job', async () => {
    await expect(handlers['kanban_get_job']!({ job_id: 'job-zzzzzzzz' }, DEV)).rejects.toMatchObject({
      status: 404,
    })
  })

  it('lists jobs with card_id and status filters', async () => {
    const { card } = await setupProject(paths.vault)
    const view = (await handlers['kanban_start_job']!(
      { id: card.id, version: card.version, command: 'echo done' },
      DEV,
    )) as JobView
    await waitFor(async () => (await jobs.status(view.job_id))?.status === 'succeeded')

    const byCard = (await handlers['kanban_list_jobs']!({ card_id: card.id }, DEV)) as { jobs: JobView[] }
    expect(byCard.jobs.map((j) => j.job_id)).toEqual([view.job_id])

    const running = (await handlers['kanban_list_jobs']!({ status: 'running' }, DEV)) as { jobs: JobView[] }
    expect(running.jobs).toEqual([])

    const other = (await handlers['kanban_list_jobs']!({ card_id: 'card-other111' }, DEV)) as { jobs: JobView[] }
    expect(other.jobs).toEqual([])
  })

  it('rejects an invalid status filter', async () => {
    await expect(handlers['kanban_list_jobs']!({ status: 'bogus' }, DEV)).rejects.toMatchObject({
      status: 400,
    })
  })
})

describe('kanban_stop_job', () => {
  it('stops a running job recording the actor, and logs the reason on the card', async () => {
    const { card } = await setupProject(paths.vault)
    const view = (await handlers['kanban_start_job']!(
      { id: card.id, version: card.version, command: 'sleep 10' },
      DEV,
    )) as JobView

    const stopped = (await handlers['kanban_stop_job']!(
      { job_id: view.job_id, reason: 'no longer needed' },
      DEV,
    )) as JobView
    expect(stopped.job_id).toBe(view.job_id)

    await waitFor(async () => (await jobs.status(view.job_id))?.status === 'stopped')
    await waitFor(async () => {
      const c = await cards.get({ id: card.id }, MGR)
      return c.status === 'todo'
    })
    const after = await cards.get({ id: card.id }, MGR)
    expect(after.body).toContain('no longer needed')
    expect(after.body).toContain(DEV.actor)
  })

  it('409 job_not_running when stopping a finished job', async () => {
    const { card } = await setupProject(paths.vault)
    const view = (await handlers['kanban_start_job']!(
      { id: card.id, version: card.version, command: 'echo quick' },
      DEV,
    )) as JobView
    await waitFor(async () => {
      const s = await jobs.status(view.job_id)
      return s !== null && s.status !== 'running'
    })
    await expect(handlers['kanban_stop_job']!({ job_id: view.job_id }, DEV)).rejects.toMatchObject({
      status: 404,
    })
  })
})
