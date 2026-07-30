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
import { JobManager, loadJobConfig, type JobConfig, type WorkflowRef } from '../../src/services/job-runner.js'
import { loadProjectMetaOrNull, saveProjectMeta } from '../../src/vault/layout.js'
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
  // dispose() agora drena finalizes em voo — nenhum completeJob vaza além do
  // teste para morrer em ENOENT depois do cleanupVault.
  for (const m of managers) await m.dispose()
  for (const k of SECRET_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
  await cleanupVault(paths)
})

/** Workflow duplo de teste: por padrão nunca roda e start() nunca é chamado sem asserção explícita. */
function makeFakeWorkflow(overrides: Partial<WorkflowRef> = {}): WorkflowRef & {
  isRunning: ReturnType<typeof vi.fn>
  start: ReturnType<typeof vi.fn>
} {
  return {
    isRunning: vi.fn().mockReturnValue(false),
    start: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeManager(
  overrides: Partial<JobConfig> = {},
  workflow: WorkflowRef = makeFakeWorkflow(),
): JobManager {
  const cfg: JobConfig = {
    logDir: path.join(paths.vault, '.kanban', 'job-logs'),
    stallThresholdMs: 60_000,
    stallPollMs: 60_000,
    maxRuntimeMs: 60_000,
    maxConcurrent: 3,
    envAllowlist: [],
    maxWakesPerSprint: 5,
    stopWaitTimeoutMs: 5_000,
    ...overrides,
  }
  const m = new JobManager(cfg, store, cardService, sse, audit, workflow, paths)
  managers.push(m)
  return m
}

/** Marca o projeto com target_repo (pré-condição de wake) preservando os sprints já salvos. */
async function setTargetRepo(project: string, targetRepo: string): Promise<void> {
  const meta = await loadProjectMetaOrNull(paths, project)
  if (!meta) throw new Error('project meta missing')
  meta.target_repo = targetRepo
  await saveProjectMeta(paths, project, meta)
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
      maxConcurrent: 1,
      envAllowlist: [],
      maxWakesPerSprint: 5,
      stopWaitTimeoutMs: 15_000,
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
        JOB_MAX_WAKES_PER_SPRINT: '2',
        JOB_STOP_WAIT_TIMEOUT_MS: '3000',
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
      maxWakesPerSprint: 2,
      stopWaitTimeoutMs: 3000,
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
    // Higiene: espera a entrada de fechamento chegar ao card antes do afterEach
    // limpar o vault — o completeJob não pode vazar além do teste.
    await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).body.includes('finished'))
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

  it('stop() só retorna depois do finalize: JobView já terminal (status/ended_at) e card já em todo', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    await m.start(startParams(jobId, card.id, sprintId, 'sleep 30'))
    const stopped = await m.stop(jobId, 'human:kaue')

    // Sem waitFor: se stop() voltasse assim que o kill signal fosse
    // disparado (comportamento antigo), a JobView ainda diria 'running' e o
    // card ainda estaria parado em job:<id> — a asserção falharia sem espera.
    expect(stopped.status).toBe('stopped')
    expect(stopped.ended_at).toBeTruthy()

    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.status).toBe('todo')
    expect(after.assigned_to).toBeNull()
  })

  it('stop() respeita o timeout de segurança: nunca trava, devolve o melhor estado conhecido', async () => {
    // Timeout de teste alto: o SIGKILL de limpeza só chega depois de
    // KILL_GRACE_MS (10s, fixo em job-runner.ts) — não relacionado ao
    // stopWaitTimeoutMs injetado, que é o próprio comportamento sob teste.
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    // stopWaitTimeoutMs bem menor que o tempo real de morte do processo — o
    // shell (o filho direto rastreado pelo 'close') ignora SIGTERM via trap,
    // então o SIGKILL só chega após KILL_GRACE_MS (10s, fixo), muito depois
    // do timeout de segurança injetado.
    const m = makeManager({ stopWaitTimeoutMs: 50 })

    await m.start(
      startParams(jobId, card.id, sprintId, `trap '' TERM; while true; do sleep 0.1; done`),
    )
    const t0 = Date.now()
    const stopped = await m.stop(jobId, 'human:kaue')
    const elapsedMs = Date.now() - t0

    // Retornou rápido (timeout de segurança), não esperou os ~10s do KILL_GRACE.
    expect(elapsedMs).toBeLessThan(3_000)
    // Finalize ainda não rodou — melhor estado conhecido é 'running' na memória.
    expect(stopped.status).toBe('running')

    // O finalize de fato acontece depois (SIGKILL do killTimer) — limpeza.
    await waitFor(async () => (await m.status(jobId))?.status === 'stopped', 15_000)
    await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo', 15_000)
  }, 20_000)

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

  it('starts concorrentes para o mesmo card: só um passa (reserva síncrona)', async () => {
    const jobId = nextJobId()
    const otherId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    // Ambos os start() entram antes de qualquer runs.set — sem a reserva
    // síncrona, os dois passariam pelos limites e os dois spawnariam.
    const [a, b] = await Promise.allSettled([
      m.start(startParams(jobId, card.id, sprintId, 'sleep 0.5')),
      m.start(startParams(otherId, card.id, sprintId, 'sleep 0.5')),
    ])
    const outcomes = [a, b].map((r) => r.status)
    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1)
    const rejected = [a, b].find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toMatchObject({
      status: 409,
      body: expect.objectContaining({ error: 'job_already_running' }),
    })
    expect(m.listRunning()).toHaveLength(1)

    const winner = m.listRunning()[0]!.job_id
    await m.stop(winner, 'human:kaue')
    await waitFor(async () => (await m.status(winner))?.status === 'stopped')
  })

  it('falha ao persistir o pid não trava o finalize (markReady em finally)', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    // O segundo save (o do pid) explode; o filho já está rodando.
    const realSave = store.save.bind(store)
    let calls = 0
    vi.spyOn(store, 'save').mockImplementation(async (job: JobRecord) => {
      calls += 1
      if (calls === 2) throw new Error('disk full')
      return realSave(job)
    })

    await expect(m.start(startParams(jobId, card.id, sprintId, 'echo done'))).rejects.toThrow('disk full')

    // Sem o markReady em finally, o close ficaria preso em readyP para sempre.
    await waitFor(async () => (await m.status(jobId))?.status === 'succeeded')
    await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
  })

  it('dispose() drena o finalize em voo: card entregue antes do shutdown', async () => {
    const jobId = nextJobId()
    const { sprintId, card } = await setupSprintAndCard(jobId)
    const m = makeManager()

    await m.start(startParams(jobId, card.id, sprintId, 'echo done'))
    // Job terminal no store = finalize em voo (o save terminal precede o
    // completeJob). O dispose deve esperar a escrita do card terminar.
    await waitFor(async () => (await m.status(jobId))?.status === 'succeeded')
    await m.dispose()

    const after = await cardService.get({ id: card.id }, MGR)
    expect(after.status).toBe('todo')
    expect(after.body).toContain(`Job \`${jobId}\` finished`)
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
      await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
    })

    it('job TERMINAL no store com card ainda preso em job:<id> → refaz o hand-back', async () => {
      // Simula crash entre o save terminal e o completeJob: o job já está
      // 'succeeded' no store, mas o card segue in_progress + job:<id>.
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)
      const now = new Date().toISOString()
      const record: JobRecord = {
        job_id: jobId,
        card_id: card.id,
        sprint_id: sprintId,
        project: 'test-project',
        command: 'echo done',
        pid: null,
        status: 'succeeded',
        started_at: now,
        ended_at: now,
        exit_code: 0,
        last_output_at: now,
        claimed_by: 'agent:dev-agent',
      }
      await store.save(record)

      const m = makeManager()
      await m.init()

      const after = await cardService.get({ id: card.id }, MGR)
      expect(after.status).toBe('todo')
      expect(after.assigned_to).toBeNull()
      expect(after.body).toContain(`Job \`${jobId}\` finished`)
      expect(after.body).toContain('hand-back replayed after server restart')
    })

    it('reconciliação não mexe em card já entregue (hand-back idempotente)', async () => {
      // Job terminal cujo card já foi devolvido: init() não escreve nada.
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard() // card sem assignment
      const now = new Date().toISOString()
      await store.save({
        job_id: jobId,
        card_id: card.id,
        sprint_id: sprintId,
        project: 'test-project',
        command: 'echo done',
        pid: null,
        status: 'succeeded',
        started_at: now,
        ended_at: now,
        exit_code: 0,
        last_output_at: now,
        claimed_by: 'agent:dev-agent',
      })

      const m = makeManager()
      await m.init()

      const after = await cardService.get({ id: card.id }, MGR)
      expect(after.version).toBe(card.version)
      expect(after.body).not.toContain('hand-back replayed')
    })

    it('erro de reidratação não derruba o boot', async () => {
      // Registro corrompido: job "running" cujo load falha não impede init().
      await fs.mkdir(store.baseDir, { recursive: true })
      await fs.writeFile(path.join(store.baseDir, 'job-corrupt9.json'), '{nope', 'utf8')
      const m = makeManager()
      await expect(m.init()).resolves.toBeUndefined()
    })
  })

  describe('wake do workflow (Task 7)', () => {
    async function assignCardToJob(card: Card, jobId: string): Promise<Card> {
      return cardService.update(
        { ...TOKEN, id: card.id, version: card.version, status: 'in_progress', assigned_to: `job:${jobId}` },
        MGR,
      )
    }

    it('workflow rodando → finalize não chama start', async () => {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)
      await setTargetRepo('test-project', '/fake/repo')
      const workflow = makeFakeWorkflow({ isRunning: vi.fn().mockReturnValue(true) })
      const m = makeManager({}, workflow)

      await m.start(startParams(jobId, card.id, sprintId, 'echo done'))
      await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
      await new Promise((r) => setTimeout(r, 100))

      expect(workflow.start).not.toHaveBeenCalled()
    })

    it('workflow parado + sprint ativa → start chamado exatamente 1x', async () => {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)
      await setTargetRepo('test-project', '/fake/repo')
      const workflow = makeFakeWorkflow()
      const m = makeManager({}, workflow)

      await m.start(startParams(jobId, card.id, sprintId, 'echo done'))
      await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
      await waitFor(() => workflow.start.mock.calls.length >= 1)

      expect(workflow.start).toHaveBeenCalledTimes(1)
      expect(workflow.start).toHaveBeenCalledWith(sprintId, 'test-project', '/fake/repo')
    })

    it('cap de wakes por sprint: a partir do cap, start não é chamado e o card recebe escalate', async () => {
      const { sprintId, card: card1 } = await setupSprintAndCard()
      await setTargetRepo('test-project', '/fake/repo')
      const workflow = makeFakeWorkflow()
      const m = makeManager({ maxWakesPerSprint: 2 }, workflow)

      const card2 = await cardService.create(
        { ...TOKEN, title: 'C2', type: 'task', project: 'test-project', sprint_id: sprintId },
        MGR,
      )
      const card3 = await cardService.create(
        { ...TOKEN, title: 'C3', type: 'task', project: 'test-project', sprint_id: sprintId },
        MGR,
      )

      for (const card of [card1, card2, card3]) {
        const jobId = nextJobId()
        const assigned = await assignCardToJob(card, jobId)
        await m.start(startParams(jobId, assigned.id, sprintId, 'echo done'))
        await waitFor(async () => (await cardService.get({ id: assigned.id }, MGR)).status === 'todo')
      }

      // A escalate no card3 só é escrita depois que o wake do 3º finalize
      // decide que o cap foi atingido — status virar 'todo' (esperado acima)
      // não implica que maybeWakeWorkflow já concluiu, então esperamos pelo
      // conteúdo final em vez de checar logo após o loop (evita flake).
      await waitFor(async () =>
        (await cardService.get({ id: card3.id }, MGR)).body.includes('workflow was not restarted'),
      )

      expect(workflow.start).toHaveBeenCalledTimes(2)
      const after3 = await cardService.get({ id: card3.id }, MGR)
      expect(after3.body).toContain('workflow was not restarted')
    })

    it('workflow.start lançando não propaga; card recebe escalate', async () => {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)
      await setTargetRepo('test-project', '/fake/repo')
      const workflow = makeFakeWorkflow({ start: vi.fn().mockRejectedValue(new Error('boom')) })
      const m = makeManager({}, workflow)

      await m.start(startParams(jobId, card.id, sprintId, 'echo done'))
      await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
      await waitFor(() => workflow.start.mock.calls.length >= 1)
      await waitFor(async () =>
        (await cardService.get({ id: card.id }, MGR)).body.includes('workflow was not restarted'),
      )

      const after = await cardService.get({ id: card.id }, MGR)
      expect(after.body).toContain('workflow was not restarted')
    })

    it('job stopped nunca aciona o wake', async () => {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)
      await setTargetRepo('test-project', '/fake/repo')
      const workflow = makeFakeWorkflow()
      const m = makeManager({}, workflow)

      await m.start(startParams(jobId, card.id, sprintId, 'sleep 30'))
      await m.stop(jobId, 'human:kaue')
      await waitFor(async () => (await m.status(jobId))?.status === 'stopped')
      await waitFor(async () => (await cardService.get({ id: card.id }, MGR)).status === 'todo')
      // Dá tempo pro finalize concluir de todo — inclusive um wake indevido.
      await new Promise((r) => setTimeout(r, 100))

      expect(workflow.start).not.toHaveBeenCalled()
    })

    it('job lost (pid morto na reidratação) nunca aciona o wake', async () => {
      const jobId = nextJobId()
      const { sprintId, card } = await setupSprintAndCard(jobId)
      await setTargetRepo('test-project', '/fake/repo')

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

      const workflow = makeFakeWorkflow()
      const m = makeManager({}, workflow)
      await m.init()

      expect((await m.status(jobId))?.status).toBe('lost')
      expect(workflow.start).not.toHaveBeenCalled()
    })
  })
})
