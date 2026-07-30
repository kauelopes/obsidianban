import { loadProjectMetaOrNull } from '../vault/layout.js'
import { badRequest, notFound } from '../services/errors.js'
import { generateJobId } from '../services/validation.js'
import { JOB_SYSTEM_CLAIMS } from '../services/card-writer.js'
import { logger } from '../util/logger.js'
import type { CardService } from '../services/card.js'
import type { JobManager } from '../services/job-runner.js'
import type { Paths } from '../config.js'
import type { JobStatus, TokenClaims } from '@obsidiankan/types'

type ToolFn = (p: Record<string, unknown>, c: TokenClaims) => Promise<unknown>

export interface JobToolDeps {
  paths: Paths
  cards: CardService
  jobs: JobManager
}

const JOB_STATUSES: ReadonlySet<string> = new Set([
  'running',
  'succeeded',
  'failed',
  'timeout',
  'stopped',
  'lost',
])

/**
 * Handlers for the four `kanban_*_job` MCP tools (category Jobs, access
 * 'all'). Kept out of index.ts so the start contract — log first, park the
 * card on the job, spawn last, revert on spawn failure — is testable without
 * booting the server. index.ts spreads the returned map into its `handlers`.
 */
export function createJobToolHandlers({ paths, cards, jobs }: JobToolDeps): Record<string, ToolFn> {
  return {
    /**
     * Contract (ordem crítica, do plano):
     *   1. validate the card (existence + caller visibility) and resolve the
     *      project's target_repo — same source kanban_workflow_start uses;
     *   2. cheap pre-check of the same limit rules JobManager.start() applies
     *      (job_already_running, job_limit_reached) — BEFORE touching the
     *      card, so the common case (limit reached) leaves no log entry;
     *   3. log the full command on the card (this is also where the
     *      version check happens — standard 409 on mismatch). If the log
     *      fails, nothing was spawned;
     *   4. park the card on the job (`assigned_to: job:<id>`, in_progress —
     *      moved there if needed, system claims);
     *   5. spawn via JobManager.start. If the spawn fails, best-effort revert
     *      of the parking so the card is not stranded on a job that never ran.
     */
    kanban_start_job: async (p, c) => {
      const id = String(p['id'] ?? '')
      const version = p['version']
      const command = typeof p['command'] === 'string' ? p['command'].trim() : ''
      if (!command) throw badRequest('missing_field', { field: 'command' })
      const description = typeof p['description'] === 'string' ? p['description'] : undefined

      const card = await cards.get({ id }, c)
      if (!card.sprint_id) {
        throw badRequest('card_not_in_sprint', {
          hint: 'jobs run against sprint work — attach the card to a sprint first',
        })
      }

      const meta = await loadProjectMetaOrNull(paths, card.project)
      if (!meta?.target_repo) {
        throw badRequest('target_repo_not_set', {
          hint: 'defina com kanban_set_project_repo antes de iniciar um job',
        })
      }
      const cwd = meta.target_repo
      const jobId = generateJobId()

      // (a) Pré-checagem barata das MESMAS regras de limite que start()
      // aplica (job_already_running, job_limit_reached) — ANTES de tocar o
      // card. Com maxConcurrent=1 por sprint, o limite virou o caminho comum:
      // sem isto, toda tentativa bloqueada deixava duas entradas de log no
      // card ("Started..." + "failed to start — card released") para um job
      // que nunca existiu. Não fecha a corrida sozinha — start() ainda faz a
      // checagem autoritativa (síncrona, com reserva) logo abaixo.
      jobs.assertCanStart(id, card.sprint_id)

      // (c) Log the command on the card — validates `version` (409 padrão) and
      // guarantees the card carries the job's full command before any spawn.
      const logged = await cards.logOnCard(
        {
          id,
          version,
          log_entry:
            `Started long-running job \`${jobId}\` (by ${c.actor}) — cwd \`${cwd}\`\n\n` +
            '```\n' +
            command +
            '\n```',
        },
        c,
      )

      // (d) Park the card on the job. System claims (precedente SYSTEM_CLAIMS):
      // a dev may call this straight from `todo` with a claim, so the card is
      // moved to in_progress together when needed.
      const parked = await cards.update(
        {
          id,
          version: logged.version,
          assigned_to: `job:${jobId}`,
          ...(card.status === 'in_progress' ? {} : { status: 'in_progress' }),
        },
        JOB_SYSTEM_CLAIMS,
      )

      // (e) Spawn last. On failure, revert the parking (best effort) so the
      // card does not stay assigned to a job that never existed.
      try {
        return await jobs.start({
          jobId,
          cardId: id,
          sprintId: card.sprint_id,
          project: card.project,
          command,
          ...(description !== undefined ? { description } : {}),
          cwd,
          claimedBy: c.actor,
        })
      } catch (err) {
        await cards
          .update(
            {
              id,
              version: parked.version,
              assigned_to: card.assigned_to,
              status: card.status,
              log_entry: `Job \`${jobId}\` failed to start — card released back to its previous state.`,
            },
            JOB_SYSTEM_CLAIMS,
          )
          .catch((revertErr) =>
            logger.warn({ err: revertErr, card: id, job: jobId }, 'jobs: failed to revert card after spawn failure'),
          )
        throw err
      }
    },

    // `kanban_get_job`/`kanban_list_jobs`/`kanban_stop_job` scope by
    // `claims.project_id` the same way card-reader.ts/card-blocker.ts/
    // card-mover.ts do: an agent token never sees or acts on a job outside
    // its own project, even knowing the job_id. Manager claims (no
    // project_id) see everything, matching the rest of the tool surface.
    kanban_get_job: async (p, c) => {
      const jobId = String(p['job_id'] ?? '')
      if (p['log_offset'] !== undefined) {
        const result = await jobs.readLog(jobId, Number(p['log_offset']))
        if (c.role === 'agent' && (!result.job || result.job.project !== c.project_id)) throw notFound()
        return result
      }
      const job = await jobs.status(jobId)
      if (!job) throw notFound()
      if (c.role === 'agent' && job.project !== c.project_id) throw notFound()
      return { job_id: jobId, job }
    },

    kanban_list_jobs: async (p, c) => {
      const cardId = typeof p['card_id'] === 'string' ? p['card_id'] : undefined
      const sprintId = typeof p['sprint_id'] === 'string' ? p['sprint_id'] : undefined
      const rawStatus = p['status']
      if (rawStatus !== undefined && (typeof rawStatus !== 'string' || !JOB_STATUSES.has(rawStatus))) {
        throw badRequest('invalid_field', { field: 'status' })
      }
      const status = rawStatus as JobStatus | undefined
      const list = await jobs.list({
        ...(cardId !== undefined ? { cardId } : {}),
        ...(sprintId !== undefined ? { sprintId } : {}),
        ...(status !== undefined ? { status } : {}),
      })
      const scoped = c.role === 'agent' ? list.filter((job) => job.project === c.project_id) : list
      return { jobs: scoped }
    },

    kanban_stop_job: async (p, c) => {
      const jobId = String(p['job_id'] ?? '')
      const reason = typeof p['reason'] === 'string' ? p['reason'].trim() : ''
      const before = await jobs.status(jobId)
      if (!before) throw notFound()
      if (c.role === 'agent' && before.project !== c.project_id) throw notFound()
      // The reason (which the finalize does not know about) is logged BEFORE
      // the stop is requested — not after. The finalize's own hand-back entry
      // ("Stopped by <actor>") lands once the process actually exits, which
      // can race an after-the-fact log write for the same card; logging first
      // guarantees the reason is on the card before that race window opens.
      // Best-effort: a failure here must not block the stop itself.
      if (reason) {
        try {
          const card = await cards.get({ id: before.card_id }, JOB_SYSTEM_CLAIMS)
          await cards.logOnCard(
            {
              id: before.card_id,
              version: card.version,
              log_entry: `Stop requested for job \`${jobId}\` by ${c.actor} — reason: ${reason}`,
            },
            JOB_SYSTEM_CLAIMS,
          )
        } catch (err) {
          logger.warn({ err, job: jobId }, 'jobs: failed to log stop reason on card')
        }
      }
      return jobs.stop(jobId, c.actor)
    },
  }
}
