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
     *   2. log the full command on the card FIRST (this is also where the
     *      version check happens — standard 409 on mismatch). If the log
     *      fails, nothing was spawned;
     *   3. park the card on the job (`assigned_to: job:<id>`, in_progress —
     *      moved there if needed, system claims);
     *   4. spawn via JobManager.start. If the spawn fails, best-effort revert
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

      // (a) Log the command on the card — validates `version` (409 padrão) and
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

      // (b) Park the card on the job. System claims (precedente SYSTEM_CLAIMS):
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

      // (c) Spawn last. On failure, revert the parking (best effort) so the
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

    kanban_get_job: async (p, _c) => {
      const jobId = String(p['job_id'] ?? '')
      if (p['log_offset'] !== undefined) {
        return jobs.readLog(jobId, Number(p['log_offset']))
      }
      const job = await jobs.status(jobId)
      if (!job) throw notFound()
      return { job_id: jobId, job }
    },

    kanban_list_jobs: async (p, _c) => {
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
      return { jobs: list }
    },

    kanban_stop_job: async (p, c) => {
      const jobId = String(p['job_id'] ?? '')
      const reason = typeof p['reason'] === 'string' ? p['reason'].trim() : ''
      // The reason (which the finalize does not know about) is logged BEFORE
      // the stop is requested — not after. The finalize's own hand-back entry
      // ("Stopped by <actor>") lands once the process actually exits, which
      // can race an after-the-fact log write for the same card; logging first
      // guarantees the reason is on the card before that race window opens.
      // Best-effort: a failure here must not block the stop itself.
      if (reason) {
        const before = await jobs.status(jobId)
        if (!before) throw notFound()
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
