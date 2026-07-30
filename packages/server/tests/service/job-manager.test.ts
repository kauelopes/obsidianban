import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { pathsFor } from '../../src/config.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims } from '../helpers/factories.js'
import { CardService } from '../../src/services/card.js'
import { SprintService } from '../../src/services/sprint.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { SSEEventBus } from '../../src/server/sse.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import { JobStore, type JobRecord } from '../../src/jobs/store.js'
import { JobManager, loadJobConfig, type JobConfig } from '../../src/services/job-runner.js'
import type { Card, SSEEvent } from '@obsidiankan/types'

let paths: Paths
let repo: CardRepository
let cardService: CardService
let sprintService: SprintService
let store: JobStore
let sse: SSEEventBus
let events: SSEEvent[]
let managers: JobManager[]

const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
const MGR = makeManagerClaims()
const TOKEN = { input_tokens: 0, output_tokens: 0, model: 'test' }

// Env fake que JAMAIS pode vazar para o filho (sanitização obrigatória).
const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'KANBAN_PM_TOKEN', 'KANBAN_DEV_TOKEN'] as const
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  repo = createTestRepo(db)
  const writer = new AtomicWriter(paths, repo)
  sse = new SSEEventBus()
  events = []
  vi.spyOn(sse, 'emit').mockImplementation((e: SSEEvent) => events.push(e))
  cardService = new CardService(paths, repo, writer, audit, sse)
  sprintService = new SprintService(paths, repo, writer, audit, sse)
  store = new JobStore(paths)
  managers = []
  savedEnv = {}
  for (const k of SECRET_KEYS) {
    savedEnv[k] = process.env[k]
    process.env[k] = `fake-secret-${k}`
  }
  vi.clearAllMocks()
})

afterEach(async () => {
  for (const m of managers) m.dispose()
  for (const k of SECRET_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
  await cleanupVault(paths)
})

function makeManager(overrides: Partial<JobConfig> = {}): JobManager {
  const cfg: JobConfig = {
    logDir: path.join(paths.vault, '.kanban', 'job-logs'),
    stallThresholdMs: 60_000,
    stallPollMs: 60_000,
    maxRuntimeMs: 60_000,
    maxConcurrent: 3,
    envAllowlist: [],
    ...overrides,
  }
  const m = new JobManager(cfg, store, cardService, sse, audit)
  managers.push(m)
  return m
}

async function setupSprintAndCard(assignedJobId?: string): Promise<{ sprintId: string; card: Card }> {
  await setupTestProject(paths, 'test-project')
  const sprint = await sprintService.createSprint({ project: 'test-project', name: 'S1' }, MGR)
  await sprintService.startSprint({ sprint_id: sprint.id }, MGR)
  let card = await cardService.create(
    { ...TOKEN, title: 'Job Card', type: 'task', project: 'test-project', sprint_id: sprint.id },
    MGR,
  )
  if (assignedJobId) {
    card = await cardService.update(
      { ...TOKEN, id: card.id, version: card.version, status: 'in_progress', assigned_to: `job:${assignedJobId}` },
      MGR,
    )
  }
  return { sprintId: sprint.id, card }
}

let jobSeq = 0
function nextJobId(): string {
  jobSeq += 1
  return `job-test${String(jobSeq).padStart(4, '0')}`
}

function startParams(jobId: string, cardId: string, sprintId: string, command: string) {
  return {
    jobId,
    cardId,
    sprintId,
    project: 'test-project',
    command,
    cwd: paths.vault,
    claimedBy: 'agent:dev-agent',
  }
}

function waitFor(pred: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    let lastErr: unknown = null
    const timer = setInterval(() => {
      void Promise.resolve()
        .then(pred)
        .then(
          (ok) => {
            if (ok) {
              clearInterval(timer)
              resolve()
            } else if (Date.now() - t0 > ms) {
              clearInterval(timer)
              reject(new Error('waitFor timeout'))
            }
          },
          (err) => {
            lastErr = err
            if (Date.now() - t0 > ms) {
              clearInterval(timer)
              reject(lastErr instanceof Error ? lastErr : new Error(String(lastErr)))
            }
          },
        )
    }, 25)
  })
}

function pidAlive(pid: number | null): boolean {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('loadJobConfig', () => {
  const p = pathsFor('/tmp/vault')

  it('defaults', () => {
    const cfg = loadJobConfig({}, p)
    expect(cfg).toEqual({
      logDir: path.join('/tmp/vault', '.kanban', 'job-logs'),
      stallThresholdMs: 1_200_000,
      stallPollMs: 60_000,
      maxRuntimeMs: 43_200_000,
      maxConcurrent: 3,
      envAllowlist: [],
    })
  })

  it('respeita overrides de ambiente', () => {
    const cfg = loadJobConfig(
      {
        JOB_LOG_DIR: '/x/job-logs',
        JOB_STALL_THRESHOLD_MS: '5000',
        JOB_STALL_POLL_MS: '100',
        JOB_MAX_RUNTIME_MS: '9999',
        JOB_MAX_CONCURRENT: '1',
        JOB_ENV_ALLOWLIST: 'FOO, BAR ,',
      },
      p,
    )
    expect(cfg).toEqual({
      logDir: '/x/job-logs',
      stallThresholdMs: 5000,
      stallPollMs: 100,
      maxRuntimeMs: 9999,
      maxConcurrent: 1,
      envAllowlist: ['FOO', 'BAR'],
    })
  })
})

describe('JobManager', () => {
  it('executa o comando, finaliza succeeded e devolve o card a todo com log', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    const view = await m.start(startParams(jobId, card.id, sprintId, 'echo done; sleep 0.3'))
    expect(view.status).toBe('running')
    expect(view.pid).toBeTypeOf('number')
    expect(m.isJobRunning(`job:${jobId}`)).toBe(true)
    expect(events.map((e) => e.type)).toContain('JOB_STARTED')

    await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')

    const done = await m.status(jobId)
    expect(done?.status).toBe('succeeded')
    expect(done?.exit_code).toBe(0)
    expect(done?.ended_at).toBeTruthy()
    expect(m.isJobRunning(`job:${jobId}`)).toBe(false)
    expect(events.map((e) => e.type)).toContain('JOB_FINISHED')

    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.status).toBe('todo')
    expect(after.assigned_to).toBeNull()
    expect(after.body).toContain(`Job \`${jobId}\` finished`)
    expect(after.body).toContain('succeeded')

    const log = await m.readLog(jobId, 0)
    expect(log.data).toContain('done')
    expect(log.size).toBeGreaterThan(0)
  })

  it('reversão condicional: card mexido por fora recebe só o log, sem revert', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    await m.start(startParams(jobId, card.id, sprintId, 'sleep 0.4'))
    // Intervenção humana: reatribui o card enquanto o job roda.
    const mid = await cardService.get({ id: card.id }, MGR)
    await cardService.update(
      { ...TOKEN, id: card.id, version: mid.version, assigned_to: 'agent:human-took-over' },
      MGR,
    )

    await waitFor(async () => (await m.status(jobId))?.status === 'succeeded')
    await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).body.includes('finished'))

    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.status).toBe('in_progress')
    expect(after.assigned_to).toBe('agent:human-took-over')
    expect(after.body).toContain(`Job \`${jobId}\` finished`)
  })

  it('watchdog: exatamente UM escalate por período contínuo de silêncio; output reseta o guard', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager({ stallThresholdMs: 120, stallPollMs: 30 })

    await m.start(startParams(jobId, card.id, sprintId, 'sleep 1; echo again; sleep 1'))

    // Primeiro período de silêncio → um único JOB_STALLED apesar de vários ticks.
    await waitFor(() => events.filter((e) => e.type === 'JOB_STALLED').length >= 1)
    await new Promise((r) => setTimeout(r, 250))
    expect(events.filter((e) => e.type === 'JOB_STALLED').length).toBe(1)

    // 'echo again' reseta o guard; o segundo silêncio escala de novo.
    await waitFor(() => events.filter((e) => e.type === 'JOB_STALLED').length === 2, 6000)

    const stalledView = await m.status(jobId)
    expect(stalledView?.status).toBe('running') // watchdog NÃO mata o processo

    await waitFor(async () => (await m.status(jobId))?.status === 'succeeded')
    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.body).toContain('has produced no output')
  }, 15_000)

  it('backstop de duração: maxRuntimeMs pequeno mata o job e finaliza timeout', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager({ maxRuntimeMs: 100 })

    const view = await m.start(startParams(jobId, card.id, sprintId, 'sleep 30'))
    await waitFor(async () => (await m.status(jobId))?.status === 'timeout')
    await waitFor(() => !pidAlive(view.pid))

    await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.body).toContain('timeout')
    expect(after.body).toContain('max-runtime backstop')
  })

  it('stop: SIGTERM no grupo, finaliza stopped com o ator no log do card', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    const view = await m.start(startParams(jobId, card.id, sprintId, 'sleep 30'))
    await m.stop(jobId, 'human:kaue')
    await waitFor(async () => (await m.status(jobId))?.status === 'stopped')
    await waitFor(() => !pidAlive(view.pid))

    await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.body).toContain('Stopped by human:kaue')
  })

  it('env do filho é construído do zero: segredos jamais vazam; allowlist passa', async () => {
    process.env['MY_JOB_EXTRA'] = 'extra-value-ok'
    try {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)
      const m = makeManager({ envAllowlist: ['MY_JOB_EXTRA'] })

      await m.start(startParams(jobId, card.id, sprintId, 'env'))
      await waitFor(async () => (await m.status(jobId))?.status === 'succeeded')

      const log = await m.readLog(jobId, 0)
      expect(log.data).toContain('PATH=')
      expect(log.data).toContain('MY_JOB_EXTRA=extra-value-ok')
      expect(log.data).not.toContain('fake-secret')
      expect(log.data).not.toContain('ANTHROPIC_API_KEY')
      expect(log.data).not.toContain('KANBAN_')
    } finally {
      delete process.env['MY_JOB_EXTRA']
    }
  })

  it('limites: 1 job running por card e maxConcurrent por sprint', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const otherCard = await cardService.create(
      { ...TOKEN, title: 'Other', type: 'task', project: 'test-project', sprint_id: sprintId },
      MGR,
    )
    const m = makeManager({ maxConcurrent: 1 })

    await m.start(startParams(jobId, card.id, sprintId, 'sleep 30'))
    await expect(m.start(startParams(nextJobId(), card.id, sprintId, 'echo x'))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: 'job_already_running' }),
    })
    await expect(m.start(startParams(nextJobId(), otherCard.id, sprintId, 'echo x'))).rejects.toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: 'job_limit_reached' }),
    })

    await m.stop(jobId, 'human:kaue')
    await waitFor(async () => (await m.status(jobId))?.status === 'stopped')
  })

  it('start valida job_id e cwd', async () => {
    const { sprintId, card } = await setupSprintAndCard()
    const m = makeManager()
    await expect(m.start(startParams('../etc', card.id, sprintId, 'echo x'))).rejects.toMatchObject({ status: 400 })
    await expect(
      m.start({ ...startParams(nextJobId(), card.id, sprintId, 'echo x'), cwd: '/nope/missing' }),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('readLog de job desconhecido é 404; status devolve null', async () => {
    const m = makeManager()
    await expect(m.readLog('job-missing1', 0)).rejects.toMatchObject({ status: 404 })
    expect(await m.status('job-missing1')).toBeNull()
    await expect(m.readLog('a/b', 0)).rejects.toMatchObject({ status: 400 })
  })

  it('listForCard ordena mais novo primeiro e computa stalled ao vivo', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    const older: JobRecord = {
      job_id: nextJobId(),
      card_id: card.id,
      sprint_id: sprintId,
      project: 'test-project',
      command: 'echo old',
      pid: null,
      status: 'succeeded',
      started_at: '2020-01-01T00:00:00.000Z',
      ended_at: '2020-01-01T00:10:00.000Z',
      exit_code: 0,
      last_output_at: '2020-01-01T00:10:00.000Z',
      claimed_by: 'agent:dev-agent',
    }
    await store.save(older)

    await m.start(startParams(jobId, card.id, sprintId, 'sleep 30'))
    const list = await m.listForCard(card.id)
    expect(list.map((j) => j.job_id)).toEqual([jobId, older.job_id])
    expect(list[0]!.stalled).toBe(false)
    expect(m.listRunning().map((j) => j.job_id)).toEqual([jobId])

    await m.stop(jobId, 'human:kaue')
    await waitFor(async () => (await m.status(jobId))?.status === 'stopped')
  })

  describe('reidratação no boot', () => {
    it('pid morto → finaliza lost e reverte o card', async () => {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)

      // Um processo que já saiu: pid garantidamente morto.
      const dead = spawn('true')
      await new Promise((resolve) => dead.on('close', resolve))
      const record: JobRecord = {
        job_id: jobId,
        card_id: card.id,
        sprint_id: sprintId,
        project: 'test-project',
        command: 'sleep 999',
        pid: dead.pid ?? null,
        status: 'running',
        started_at: new Date().toISOString(),
        last_output_at: new Date().toISOString(),
        claimed_by: 'agent:dev-agent',
      }
      await store.save(record)

      const m = makeManager()
      await m.init()

      expect((await m.status(jobId))?.status).toBe('lost')
      const after = await cardService.get({ id: card.id }, MGR)
      expect(after.status).toBe('todo')
      expect(after.assigned_to).toBeNull()
      expect(after.body).toContain('lost')
      expect(events.map((e) => e.type)).toContain('JOB_FINISHED')
    })

    it('pid vivo → readota (running, listRunning) e stop ainda funciona', async () => {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)

      const logDir = path.join(paths.vault, '.kanban', 'job-logs')
      await fs.mkdir(logDir, { recursive: true })
      const alive = spawn('sleep 30', { shell: true, detached: true, stdio: 'ignore' })
      alive.unref()
      const record: JobRecord = {
        job_id: jobId,
        card_id: card.id,
        sprint_id: sprintId,
        project: 'test-project',
        command: 'sleep 30',
        pid: alive.pid ?? null,
        status: 'running',
        started_at: new Date().toISOString(),
        last_output_at: new Date().toISOString(),
        claimed_by: 'agent:dev-agent',
      }
      await store.save(record)

      const m = makeManager()
      await m.init()

      expect((await m.status(jobId))?.status).toBe('running')
      expect(m.listRunning().map((j) => j.job_id)).toEqual([jobId])
      expect(m.isJobRunning(`job:${jobId}`)).toBe(true)

      await m.stop(jobId, 'human:kaue')
      await waitFor(async () => (await m.status(jobId))?.status === 'stopped')
      await waitFor(() => !pidAlive(alive.pid ?? null))
      const after = await cardService.get({ id: card.id }, MGR)
      expect(after.status).toBe('todo')
    })

    it('erro de reidratação não derruba o boot', async () => {
      // Registro corrompido: job "running" cujo load falha não impede init().
      await fs.mkdir(store.baseDir, { recursive: true })
      await fs.writeFile(path.join(store.baseDir, 'job-corrupt9.json'), '{nope', 'utf8')
      const m = makeManager()
      await expect(m.init()).resolves.toBeUndefined()
    })
  })
})
