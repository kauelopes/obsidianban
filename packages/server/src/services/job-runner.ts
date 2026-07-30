import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs'
import path from 'node:path'
import { logger } from '../util/logger.js'
import { badRequest, conflict, notFound, HttpError } from './errors.js'
import { readLogSlice } from '../util/log-file.js'
import { JobStore, JOB_ID_RE, type JobRecord } from '../jobs/store.js'
import { JOB_SYSTEM_CLAIMS } from './card-writer.js'
import type { CardService } from './card.js'
import type { AuditLogger } from '../audit/logger.js'
import type { SSEEventBus } from '../server/sse.js'
import type { Paths } from '../config.js'
import type { JobStatus, JobView, LogKind } from '@obsidiankan/types'
import { WORKFLOW_LOG_CHUNK_MAX } from '../util/constants.js'

export interface JobConfig {
  logDir: string
  /** Silêncio contínuo acima disto marca o job como stalled (escalate no card). */
  stallThresholdMs: number
  /** Período do único setInterval do watchdog. */
  stallPollMs: number
  /** Backstop de duração: acima disto o job é morto e finalizado como timeout. */
  maxRuntimeMs: number
  /** Máximo de jobs `running` simultâneos por sprint. */
  maxConcurrent: number
  /** Nomes extras de env repassados ao filho, além da base fixa. */
  envAllowlist: string[]
}

/**
 * Config do runner de jobs, no padrão de loadWorkflowConfig: sempre retorna
 * uma config utilizável, com tudo sobrescritível por env e injetável em teste.
 */
export function loadJobConfig(env: NodeJS.ProcessEnv, paths: Paths): JobConfig {
  const num = (key: string, def: number): number => {
    const raw = env[key]
    const n = raw === undefined ? NaN : Number(raw)
    return Number.isFinite(n) && n > 0 ? n : def
  }
  const allowlist = (env['JOB_ENV_ALLOWLIST'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  return {
    logDir: env['JOB_LOG_DIR'] ?? path.join(paths.vault, '.kanban', 'job-logs'),
    stallThresholdMs: num('JOB_STALL_THRESHOLD_MS', 1_200_000),
    stallPollMs: num('JOB_STALL_POLL_MS', 60_000),
    maxRuntimeMs: num('JOB_MAX_RUNTIME_MS', 43_200_000),
    maxConcurrent: num('JOB_MAX_CONCURRENT', 3),
    envAllowlist: allowlist,
  }
}

export interface JobStartParams {
  jobId: string
  cardId: string
  sprintId: string
  project: string
  command: string
  description?: string
  cwd: string
  claimedBy: string
}

export interface JobLogResult {
  job_id: string
  job: JobView | null
  size: number
  data: string
}

interface Run {
  record: JobRecord
  /** null para jobs readotados pós-restart — não há mais streams/eventos. */
  child: ChildProcess | null
  logPath: string
  /** Fonte de verdade do last_output_at com o servidor de pé (ms epoch). */
  lastOutputAtMs: number
  /** Última persistência de last_output_at no store (throttle de 10s). */
  lastPersistedOutputAtMs: number
  /**
   * Guard do watchdog: instante do escalate do período de silêncio corrente,
   * ou null quando o job produziu output desde então. Garante exatamente UM
   * escalate por período contínuo de silêncio.
   */
  lastStallLoggedAt: number | null
  /** true depois de stop() — decide 'stopped' no finalize. */
  stopping: boolean
  /** Ator que pediu o stop, para registro no log do card. */
  stoppedBy: string | null
  /** true quando o backstop de duração matou o job — decide 'timeout'. */
  timedOut: boolean
  /** Job readotado na reidratação: liveness/output via polling, não eventos. */
  readopted: boolean
  finalizing: boolean
  out: WriteStream | null
  runtimeTimer: NodeJS.Timeout | null
  killTimer: NodeJS.Timeout | null
  deathPoll: NodeJS.Timeout | null
}

/** Env fixa e mínima do filho — nada de process.env espalhado (segurança). */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'USER'] as const

/** Persistência de last_output_at no store no máximo 1x por este intervalo. */
const OUTPUT_PERSIST_THROTTLE_MS = 10_000

/** Espera entre SIGTERM e SIGKILL num stop/timeout. */
const KILL_GRACE_MS = 10_000

/** Poll de morte para jobs sem child (readotados) após um kill. */
const DEATH_POLL_MS = 250

/** Tail do log incluído na entrada de fechamento do card. */
const CARD_LOG_TAIL_BYTES = 2_000
const CARD_LOG_TAIL_LINES = 5

/**
 * Executa comandos de horas de forma durável para cards do kanban, espelhando
 * a estrutura do WorkflowManager: processo detached (líder de grupo, para o
 * stop matar filhos também), stdout+stderr num log em disco, estado corrente
 * em memória. Diferenças-chave:
 *   - cada job é persistido no JobStore (sobrevive a restart; reidratação em
 *     init() readota processos vivos e finaliza como 'lost' os mortos);
 *   - watchdog único de silêncio (JOB_STALLED, nunca mata o processo);
 *   - backstop de duração (maxRuntimeMs → kill + 'timeout');
 *   - ao terminar, devolve o card a `todo` via CardService.completeJob —
 *     condicionado ao card ainda estar parado no job (intervenção humana vence).
 * Sem wake de workflow aqui (Task 7).
 */
export class JobManager {
  private readonly runs = new Map<string, Run>()
  /**
   * Reservas síncronas de start() em voo: os checks de limite são síncronos,
   * mas runs.set só acontece depois de vários awaits — sem a reserva, dois
   * start() concorrentes para o mesmo card passariam ambos pelos limites e
   * ambos spawnariam. A reserva entra ANTES do primeiro await e sai (finally)
   * quando o run já está em `runs` ou o start falhou.
   */
  private readonly pendingStarts = new Map<string, { cardId: string; sprintId: string }>()
  /** Finalizes em voo — drenados no dispose() para o shutdown não estrandar cards. */
  private readonly pendingFinalizes = new Set<Promise<void>>()
  private readonly watchdog: NodeJS.Timeout
  private tickInFlight = false

  constructor(
    private readonly cfg: JobConfig,
    private readonly store: JobStore,
    private readonly cards: CardService,
    private readonly sse: SSEEventBus,
    private readonly audit: AuditLogger,
  ) {
    this.watchdog = setInterval(() => void this.tick(), this.cfg.stallPollMs)
    this.watchdog.unref()
  }

  /**
   * Reidratação pós-restart: jobs `running` no store são readotados quando o
   * pid segue vivo (watchdog/backstop re-armados; output acompanhado via
   * mtime do log, já que não há mais streams) e finalizados como 'lost'
   * quando o pid morreu. Nenhum erro aqui derruba o boot.
   */
  async init(): Promise<void> {
    const running = await this.store.listRunning().catch((err) => {
      logger.warn({ err }, 'jobs: rehydration listing failed — starting empty')
      return [] as JobRecord[]
    })
    for (const record of running) {
      try {
        await this.rehydrate(record)
      } catch (err) {
        logger.warn({ err, job: record.job_id }, 'jobs: rehydration failed for job — skipping')
      }
    }
    // Janela de crash entre o save terminal e o completeJob: um card ainda
    // apontando para um job já terminal ficaria estrandado para sempre (a
    // reidratação acima só olha jobs running). Refaz o hand-back — idempotente:
    // completeJob só reverte se o card seguir exatamente no job.
    await this.reconcileTerminalJobs().catch((err) => {
      logger.warn({ err }, 'jobs: terminal-job reconciliation failed — continuing boot')
    })
  }

  /**
   * Encerra timers e DRENA os finalizes em voo (testes / shutdown gracioso).
   * Não mata jobs — eles são duráveis; mas um finalize que já começou termina
   * de escrever store + card antes de retornarmos, fechando a janela em que o
   * job ficaria terminal no store com o card ainda preso em `job:<id>`.
   */
  async dispose(): Promise<void> {
    clearInterval(this.watchdog)
    for (const run of this.runs.values()) {
      if (run.runtimeTimer) clearTimeout(run.runtimeTimer)
      if (run.killTimer) clearTimeout(run.killTimer)
      if (run.deathPoll) clearInterval(run.deathPoll)
    }
    await Promise.allSettled([...this.pendingFinalizes])
  }

  /** Supervisão: `assigned_to` = `job:<id>` com o job de fato rodando? */
  isJobRunning(assignedTo: string | null | undefined): boolean {
    if (!assignedTo || !assignedTo.startsWith('job:')) return false
    return this.runs.get(assignedTo.slice('job:'.length))?.record.status === 'running'
  }

  /** View corrente: memória primeiro (stalled ao vivo), store como fallback. */
  async status(jobId: string): Promise<JobView | null> {
    if (!JOB_ID_RE.test(jobId)) throw badRequest('invalid_field', { field: 'job_id' })
    const run = this.runs.get(jobId)
    if (run) return this.toView(run)
    const record = await this.store.load(jobId)
    return record ? { ...record, stalled: false } : null
  }

  /**
   * Jobs do card, mais novo primeiro (ordenado aqui por started_at desc — o
   * JobStore.list() não ordena, por decisão do Task 3). Registros em memória
   * sobrepõem o store (last_output_at pode estar até 10s atrasado em disco).
   */
  async listForCard(cardId: string): Promise<JobView[]> {
    const records = await this.store.listByCard(cardId)
    return this.overlay(records)
  }

  /** Jobs running em memória (fonte de verdade com o servidor de pé). */
  listRunning(): JobView[] {
    const views = [...this.runs.values()]
      .filter((r) => r.record.status === 'running')
      .map((r) => this.toView(r))
    return views.sort((a, b) => b.started_at.localeCompare(a.started_at))
  }

  async start(params: JobStartParams): Promise<JobView> {
    const { jobId, cardId, sprintId } = params
    if (!JOB_ID_RE.test(jobId)) throw badRequest('invalid_field', { field: 'job_id' })
    if (this.runs.has(jobId) || this.pendingStarts.has(jobId)) {
      throw conflict({ error: 'job_already_exists', job_id: jobId })
    }

    // Limites: 1 job running por card; maxConcurrent por sprint. Contam tanto
    // os runs quanto os starts ainda em voo (pendingStarts) — checks e reserva
    // acontecem SINCRONAMENTE, antes de qualquer await, para dois start()
    // concorrentes não passarem ambos.
    for (const r of this.runs.values()) {
      if (r.record.status !== 'running') continue
      if (r.record.card_id === cardId) {
        throw conflict({ error: 'job_already_running', card_id: cardId, job_id: r.record.job_id })
      }
    }
    for (const [pendingId, p] of this.pendingStarts) {
      if (p.cardId === cardId) {
        throw conflict({ error: 'job_already_running', card_id: cardId, job_id: pendingId })
      }
    }
    const runningInSprint =
      [...this.runs.values()].filter(
        (r) => r.record.status === 'running' && r.record.sprint_id === sprintId,
      ).length +
      [...this.pendingStarts.values()].filter((p) => p.sprintId === sprintId).length
    if (runningInSprint >= this.cfg.maxConcurrent) {
      throw conflict({
        error: 'job_limit_reached',
        sprint_id: sprintId,
        max_concurrent: this.cfg.maxConcurrent,
      })
    }

    this.pendingStarts.set(jobId, { cardId, sprintId })
    try {
      return await this.doStart(params)
    } finally {
      // O run já está em `runs` (sucesso) ou o start falhou — a reserva sai.
      this.pendingStarts.delete(jobId)
    }
  }

  private async doStart(params: JobStartParams): Promise<JobView> {
    const { jobId, cardId, sprintId, project, command, description, cwd, claimedBy } = params
    const cwdOk = await fs.stat(cwd).then((s) => s.isDirectory(), () => false)
    if (!cwdOk) throw badRequest('job_cwd_missing', { cwd })

    await fs.mkdir(this.cfg.logDir, { recursive: true })
    const logPath = path.join(this.cfg.logDir, `${jobId}.log`)
    const out = createWriteStream(logPath, { flags: 'a' })
    out.write(`\n[${new Date().toISOString()}] ── job start — ${jobId} (card ${cardId}) — ${command}\n`)

    const now = new Date().toISOString()
    const record: JobRecord = {
      job_id: jobId,
      card_id: cardId,
      sprint_id: sprintId,
      project,
      command,
      pid: null,
      status: 'running',
      started_at: now,
      last_output_at: now,
      claimed_by: claimedBy,
    }
    if (description !== undefined) record.description = description
    // Persistido ANTES do spawn: se o servidor cair entre o save e o spawn, a
    // reidratação vê pid null (morto) e finaliza como 'lost' — nunca perdemos
    // o rastro de um processo vivo sem registro.
    await this.store.save(record)

    const child = spawn(command, {
      shell: true,
      cwd,
      env: this.buildChildEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    record.pid = child.pid ?? null

    const run: Run = {
      record,
      child,
      logPath,
      lastOutputAtMs: Date.now(),
      lastPersistedOutputAtMs: Date.now(),
      lastStallLoggedAt: null,
      stopping: false,
      stoppedBy: null,
      timedOut: false,
      readopted: false,
      finalizing: false,
      out,
      runtimeTimer: null,
      killTimer: null,
      deathPoll: null,
    }
    this.runs.set(jobId, run)

    // Handlers registrados SINCRONAMENTE após o spawn: um comando que termina
    // em milissegundos (ou despeja output imediato) não pode correr contra o
    // await do save do pid — perderíamos o close/output. O finalize em si
    // espera o start acabar de persistir (readyP) para nunca ser sobrescrito
    // pelo save do pid logo abaixo.
    let markReady!: () => void
    const readyP = new Promise<void>((resolve) => { markReady = resolve })
    const onData = (chunk: Buffer) => {
      out.write(chunk)
      this.touchOutput(run)
    }
    child.stdout!.on('data', onData)
    child.stderr!.on('data', onData)
    child.on('error', (err) => {
      logger.error({ err, job: jobId }, 'jobs: child process error')
      void readyP.then(() => this.trackFinalize(run, 'failed', null))
    })
    child.on('close', (code) => {
      const status: JobStatus = run.timedOut
        ? 'timeout'
        : run.stopping
          ? 'stopped'
          : code === 0
            ? 'succeeded'
            : 'failed'
      void readyP.then(() => this.trackFinalize(run, status, code))
    })
    child.unref()

    this.armRuntimeBackstop(run, this.cfg.maxRuntimeMs)

    // markReady em finally: se o save do pid falhar, os handlers close/error
    // (gateados em readyP) NÃO podem ficar presos para sempre — o filho já
    // está rodando e precisa ser finalizável nesta sessão.
    try {
      await this.store.save(record) // agora com pid
    } finally {
      markReady()
    }

    logger.info({ job: jobId, card: cardId, pid: child.pid, log: logPath, cwd }, 'jobs: launched')
    this.sse.emit({
      type: 'JOB_STARTED',
      payload: { job_id: jobId, card_id: cardId, sprint_id: sprintId, project },
    })
    void this.audit.log({
      op: 'JOB_STARTED',
      project,
      card_id: cardId,
      sprint_id: sprintId,
      job_id: jobId,
      actor: claimedBy,
    }).catch((err) => logger.warn({ err, job: jobId }, 'jobs: audit JOB_STARTED failed'))
    return this.toView(run)
  }

  /**
   * SIGTERM no grupo inteiro + SIGKILL após 10s se ainda vivo; finaliza como
   * 'stopped' com o ator registrado na entrada de log do card.
   */
  async stop(jobId: string, actor: string): Promise<JobView> {
    if (!JOB_ID_RE.test(jobId)) throw badRequest('invalid_field', { field: 'job_id' })
    const run = this.runs.get(jobId)
    if (!run) throw notFound()
    if (run.record.status !== 'running' || run.record.pid === null) {
      throw conflict({ error: 'job_not_running', job_id: jobId, status: run.record.status })
    }
    run.stopping = true
    run.stoppedBy = actor
    this.killGroup(run)
    if (run.readopted) this.armDeathPoll(run)
    return this.toView(run)
  }

  /**
   * Leitura incremental do log por offset, mesmo contrato do
   * WorkflowManager.readLog: funciona também pós-restart, direto do disco.
   */
  async readLog(jobId: string, offset: number): Promise<JobLogResult> {
    if (!JOB_ID_RE.test(jobId)) throw badRequest('invalid_field', { field: 'job_id' })
    const run = this.runs.get(jobId)
    const logPath = run?.logPath ?? path.join(this.cfg.logDir, `${jobId}.log`)

    const slice = await readLogSlice(logPath, offset, WORKFLOW_LOG_CHUNK_MAX)
    const job = run ? this.toView(run) : await this.status(jobId)
    if (!slice) {
      if (!job) throw notFound()
      return { job_id: jobId, job, size: 0, data: '' }
    }
    return { job_id: jobId, job, size: slice.size, data: slice.data }
  }

  // ── privados ───────────────────────────────────────────────────────────────

  /**
   * Env do filho construído do ZERO — só a base mínima (PATH/HOME/locale/tmp)
   * mais os nomes explicitamente liberados em JOB_ENV_ALLOWLIST. Em especial,
   * ANTHROPIC_API_KEY e KANBAN_* jamais chegam ao processo do job.
   */
  private buildChildEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const key of [...BASE_ENV_KEYS, ...this.cfg.envAllowlist]) {
      const value = process.env[key]
      if (value !== undefined) env[key] = value
    }
    return env
  }

  private toView(run: Run): JobView {
    return {
      ...run.record,
      last_output_at: new Date(run.lastOutputAtMs).toISOString(),
      stalled: this.isStalled(run),
    }
  }

  private isStalled(run: Run): boolean {
    return (
      run.record.status === 'running' &&
      Date.now() - run.lastOutputAtMs > this.cfg.stallThresholdMs
    )
  }

  private async overlay(records: JobRecord[]): Promise<JobView[]> {
    const views = records.map((record) => {
      const run = this.runs.get(record.job_id)
      return run ? this.toView(run) : { ...record, stalled: false }
    })
    return views.sort((a, b) => b.started_at.localeCompare(a.started_at))
  }

  /** Output novo: memória é a fonte de verdade; store com throttle de 10s. */
  private touchOutput(run: Run): void {
    const now = Date.now()
    run.lastOutputAtMs = now
    run.lastStallLoggedAt = null // silêncio quebrado — próximo stall escala de novo
    if (now - run.lastPersistedOutputAtMs >= OUTPUT_PERSIST_THROTTLE_MS) {
      run.lastPersistedOutputAtMs = now
      run.record.last_output_at = new Date(now).toISOString()
      void this.store.save(run.record).catch((err) => {
        logger.warn({ err, job: run.record.job_id }, 'jobs: failed to persist last_output_at')
      })
    }
  }

  private armRuntimeBackstop(run: Run, ms: number): void {
    run.runtimeTimer = setTimeout(() => {
      if (run.record.status !== 'running') return
      logger.warn({ job: run.record.job_id, max_runtime_ms: this.cfg.maxRuntimeMs }, 'jobs: max runtime exceeded — killing')
      run.timedOut = true
      this.killGroup(run)
      if (run.readopted) this.armDeathPoll(run)
    }, Math.max(0, ms))
    run.runtimeTimer.unref()
  }

  /** SIGTERM no grupo agora, SIGKILL após KILL_GRACE_MS se seguir vivo. */
  private killGroup(run: Run): void {
    const pid = run.record.pid
    if (pid === null) return
    try {
      process.kill(-pid, 'SIGTERM')
    } catch (err) {
      logger.warn({ err, job: run.record.job_id, pid }, 'jobs: SIGTERM failed')
      // Grupo já não existe — trate como morto pelo caminho corrente.
      const status: JobStatus = run.timedOut ? 'timeout' : run.stopping ? 'stopped' : 'lost'
      void this.trackFinalize(run, status, null)
      return
    }
    run.killTimer = setTimeout(() => {
      if (run.record.status !== 'running') return
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* já morreu entre o TERM e o KILL */
      }
    }, KILL_GRACE_MS)
    run.killTimer.unref()
  }

  /**
   * Jobs readotados não têm evento 'close': detecta a morte por polling de
   * kill(pid, 0) após um stop/timeout.
   */
  private armDeathPoll(run: Run): void {
    if (run.deathPoll) return
    run.deathPoll = setInterval(() => {
      if (run.record.status !== 'running') {
        if (run.deathPoll) clearInterval(run.deathPoll)
        return
      }
      if (!this.isPidAlive(run.record.pid)) {
        if (run.deathPoll) clearInterval(run.deathPoll)
        const status: JobStatus = run.timedOut ? 'timeout' : run.stopping ? 'stopped' : 'lost'
        void this.trackFinalize(run, status, null)
      }
    }, DEATH_POLL_MS)
    run.deathPoll.unref()
  }

  private isPidAlive(pid: number | null): boolean {
    if (pid === null) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  private async rehydrate(record: JobRecord): Promise<void> {
    const logPath = path.join(this.cfg.logDir, `${record.job_id}.log`)
    const startedAtMs = Date.parse(record.started_at) || Date.now()
    const stat = await fs.stat(logPath).catch(() => null)
    const lastOutputAtMs = stat ? stat.mtimeMs : startedAtMs

    const run: Run = {
      record,
      child: null,
      logPath,
      lastOutputAtMs,
      lastPersistedOutputAtMs: Date.now(),
      lastStallLoggedAt: null,
      stopping: false,
      stoppedBy: null,
      timedOut: false,
      readopted: true,
      finalizing: false,
      out: null,
      runtimeTimer: null,
      killTimer: null,
      deathPoll: null,
    }

    if (this.isPidAlive(record.pid)) {
      this.runs.set(record.job_id, run)
      // Backstop re-armado com o tempo restante da vida original do job.
      this.armRuntimeBackstop(run, this.cfg.maxRuntimeMs - (Date.now() - startedAtMs))
      logger.info({ job: record.job_id, pid: record.pid }, 'jobs: readopted running job after restart')
      return
    }

    // Processo morreu com o servidor fora do ar — exit code irrecuperável.
    this.runs.set(record.job_id, run)
    logger.warn({ job: record.job_id, pid: record.pid }, 'jobs: job process died while server was down — finalizing as lost')
    await this.trackFinalize(run, 'lost', null)
  }

  /**
   * Tick único do watchdog para todos os jobs running:
   *   - readotados: liveness via kill(pid,0) e output via mtime do log (sem
   *     streams pós-restart, o arquivo é o único sinal de vida);
   *   - todos: silêncio acima do threshold → UM escalate no card + SSE/audit
   *     JOB_STALLED por período contínuo de silêncio. Nunca mata o processo.
   */
  private async tick(): Promise<void> {
    if (this.tickInFlight) return
    this.tickInFlight = true
    try {
      for (const run of this.runs.values()) {
        if (run.record.status !== 'running') continue

        if (run.readopted) {
          const stat = await fs.stat(run.logPath).catch(() => null)
          if (stat && stat.mtimeMs > run.lastOutputAtMs) {
            run.lastOutputAtMs = stat.mtimeMs
            run.lastStallLoggedAt = null
            run.record.last_output_at = new Date(stat.mtimeMs).toISOString()
            void this.store.save(run.record).catch(() => {})
          }
          if (!this.isPidAlive(run.record.pid)) {
            const status: JobStatus = run.timedOut ? 'timeout' : run.stopping ? 'stopped' : 'lost'
            await this.trackFinalize(run, status, null)
            continue
          }
        }

        if (this.isStalled(run) && run.lastStallLoggedAt === null) {
          run.lastStallLoggedAt = Date.now()
          await this.reportStall(run)
        }
      }
    } catch (err) {
      logger.warn({ err }, 'jobs: watchdog tick failed')
    } finally {
      this.tickInFlight = false
    }
  }

  private async reportStall(run: Run): Promise<void> {
    const { job_id, card_id, sprint_id, project, pid } = run.record
    const silentMin = Math.round((Date.now() - run.lastOutputAtMs) / 60_000)
    logger.warn({ job: job_id, card: card_id, silent_min: silentMin }, 'jobs: job stalled (no output)')
    await this.appendCardLog(
      card_id,
      `Job \`${job_id}\` has produced no output for ~${silentMin} min ` +
        `(threshold ${Math.round(this.cfg.stallThresholdMs / 60_000)} min). ` +
        `The process is still running (pid ${pid ?? 'unknown'}) and was NOT killed — ` +
        `check the job log and intervene if needed.`,
      'escalate',
    )
    this.sse.emit({ type: 'JOB_STALLED', payload: { job_id, card_id, sprint_id, project } })
    void this.audit.log({
      op: 'JOB_STALLED',
      project,
      card_id,
      sprint_id,
      job_id,
      actor: JOB_SYSTEM_CLAIMS.actor,
    }).catch((err) => logger.warn({ err, job: job_id }, 'jobs: audit JOB_STALLED failed'))
  }

  /**
   * Entrada de log avulsa no card (stall), sem reversão — completeJob não
   * serve aqui porque o card ESTÁ no estado esperado e deve continuar nele.
   * Mesmo retry curto de versão do completeJob: não há chamador vivo p/ 409.
   */
  private async appendCardLog(cardId: string, entry: string, kind: LogKind): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const card = await this.cards.get({ id: cardId }, JOB_SYSTEM_CLAIMS)
        await this.cards.logOnCard(
          { id: cardId, version: card.version, log_entry: entry, log_kind: kind },
          JOB_SYSTEM_CLAIMS,
        )
        return
      } catch (err) {
        if (err instanceof HttpError && err.status === 409 && attempt < 2) continue
        logger.warn({ err, card: cardId }, 'jobs: failed to append log entry to card')
        return
      }
    }
  }

  /**
   * Único ponto de entrada para o finalize: registra a promise em
   * pendingFinalizes para o dispose() poder drenar — um shutdown no meio de um
   * finalize esperaria a escrita do card, em vez de deixar o job terminal no
   * store com o card ainda preso em `job:<id>`.
   */
  private trackFinalize(run: Run, status: JobStatus, code: number | null): Promise<void> {
    const p = this.finalize(run, status, code).catch((err) => {
      logger.error({ err, job: run.record.job_id }, 'jobs: finalize failed')
    })
    this.pendingFinalizes.add(p)
    void p.finally(() => this.pendingFinalizes.delete(p))
    return p
  }

  /**
   * Reconciliação pós-boot da janela de crash entre o save terminal e o
   * completeJob: para cada card cujo assigned_to ainda aponte um job TERMINAL
   * do store, refaz o hand-back (entrada de fechamento + reversão condicional).
   */
  private async reconcileTerminalJobs(): Promise<void> {
    const all = await this.store.list()
    const terminal = new Map(all.filter((j) => j.status !== 'running').map((j) => [j.job_id, j]))
    if (terminal.size === 0) return

    for (const cardId of new Set([...terminal.values()].map((j) => j.card_id))) {
      const card = await this.cards.get({ id: cardId }, JOB_SYSTEM_CLAIMS).catch(() => null)
      const assigned = card?.assigned_to
      if (!card || !assigned?.startsWith('job:')) continue
      const record = terminal.get(assigned.slice('job:'.length))
      if (!record || this.runs.has(record.job_id)) continue

      logger.warn(
        { job: record.job_id, card: cardId, status: record.status },
        'jobs: card still parked on a terminal job — replaying hand-back',
      )
      const entry =
        (await this.buildCompletionEntry(record, record.status, record.exit_code ?? null, null)) +
        '\n\n_(hand-back replayed after server restart — the original completion write was interrupted)_'
      try {
        await this.cards.completeJob(cardId, {
          expectedStatus: 'in_progress',
          expectedAssignedTo: assigned,
          logEntry: entry,
          logKind: record.status === 'succeeded' || record.status === 'stopped' ? 'progress' : 'escalate',
        })
      } catch (err) {
        logger.warn({ err, job: record.job_id, card: cardId }, 'jobs: hand-back replay failed')
      }
    }
  }

  /**
   * Caminho único de término (exit/error/timeout/stop/lost): fecha o registro
   * no store, emite JOB_FINISHED (SSE) + audit (JOB_KILLED para stop manual,
   * JOB_FINISHED para o resto) e devolve o card a `todo` via completeJob —
   * que só reverte se o card ainda estiver exatamente in_progress + job:<id>.
   * Sempre chamado via trackFinalize (drenável no dispose).
   */
  private async finalize(run: Run, status: JobStatus, code: number | null): Promise<void> {
    if (run.finalizing || run.record.status !== 'running') return
    run.finalizing = true
    if (run.runtimeTimer) clearTimeout(run.runtimeTimer)
    if (run.killTimer) clearTimeout(run.killTimer)
    if (run.deathPoll) clearInterval(run.deathPoll)
    run.child = null

    const record = run.record
    record.status = status
    record.ended_at = new Date().toISOString()
    record.last_output_at = new Date(run.lastOutputAtMs).toISOString()
    // exit_code só quando o processo de fato saiu com código (não sinal/lost).
    if (code !== null) record.exit_code = code

    run.out?.end(`[${record.ended_at}] ── job ${status}${code !== null ? ` (exit ${code})` : ''}\n`)
    run.out = null

    await this.store.save(record).catch((err) => {
      logger.error({ err, job: record.job_id }, 'jobs: failed to persist terminal state')
    })

    logger.info({ job: record.job_id, status, code }, 'jobs: finished')
    this.sse.emit({
      type: 'JOB_FINISHED',
      payload: {
        job_id: record.job_id,
        card_id: record.card_id,
        sprint_id: record.sprint_id,
        project: record.project,
        status,
        exit_code: code,
      },
    })
    void this.audit.log({
      op: status === 'stopped' ? 'JOB_KILLED' : 'JOB_FINISHED',
      project: record.project,
      card_id: record.card_id,
      sprint_id: record.sprint_id,
      job_id: record.job_id,
      actor: run.stoppedBy ?? JOB_SYSTEM_CLAIMS.actor,
      reason: status,
    }).catch((err) => logger.warn({ err, job: record.job_id }, 'jobs: audit finalize failed'))

    // Reversão condicional do card — depois de tudo persistido, para que uma
    // falha aqui nunca deixe o job "running" fantasma no store.
    try {
      await this.cards.completeJob(record.card_id, {
        expectedStatus: 'in_progress',
        expectedAssignedTo: `job:${record.job_id}`,
        logEntry: await this.buildCompletionEntry(record, status, code, run.stoppedBy),
        logKind: status === 'succeeded' || status === 'stopped' ? 'progress' : 'escalate',
      })
    } catch (err) {
      logger.warn({ err, job: record.job_id, card: record.card_id }, 'jobs: completeJob on card failed')
    }

    // Registro terminal sai da memória — status()/listForCard leem do store.
    this.runs.delete(record.job_id)
  }

  /**
   * Resumo curto para o log do card: status, exit code, duração, tail do log.
   * Recebe o record (não o Run) para servir também ao replay da reconciliação
   * pós-boot, quando não há mais Run em memória.
   */
  private async buildCompletionEntry(
    record: JobRecord,
    status: JobStatus,
    code: number | null,
    stoppedBy: string | null,
  ): Promise<string> {
    const startedMs = Date.parse(record.started_at) || Date.now()
    const endedMs = Date.parse(record.ended_at ?? '') || Date.now()
    const durationMin = Math.max(0, Math.round((endedMs - startedMs) / 60_000))
    const lines = [
      `Job \`${record.job_id}\` finished — status **${status}**, ` +
        `exit code ${code ?? 'n/a'}, duration ~${durationMin} min.`,
    ]
    if (status === 'stopped' && stoppedBy) lines.push(`Stopped by ${stoppedBy}.`)
    if (status === 'timeout') lines.push(`Killed by the max-runtime backstop (${Math.round(this.cfg.maxRuntimeMs / 3_600_000)}h).`)
    if (status === 'lost') lines.push('Process died while the server was down — exit code unknown.')

    const logPath = path.join(this.cfg.logDir, `${record.job_id}.log`)
    const stat = await fs.stat(logPath).catch(() => null)
    if (stat && stat.size > 0) {
      const slice = await readLogSlice(logPath, Math.max(0, stat.size - CARD_LOG_TAIL_BYTES)).catch(() => null)
      const tail = slice?.data.trimEnd().split('\n').slice(-CARD_LOG_TAIL_LINES).join('\n')
      if (tail) lines.push('', 'Last output:', '```', tail, '```')
    }
    return lines.join('\n')
  }
}
