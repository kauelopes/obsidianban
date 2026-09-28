import type { CardMove, ModuleDataApi, ProjectInfo } from '@obsidiankan/module-sdk'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import type { MetricsService } from '../services/metrics.js'
import type { FlowService } from '../services/flow.js'
import type { DigestService } from '../services/digest.js'
import type { SupervisionService } from '../services/supervision.js'
import { scanAuditLog } from '../services/audit-scan.js'
import { listProjectsSafe, loadProjectMetaOrNull, type ProjectMeta } from '../vault/layout.js'
import { DIGEST_AUDIT_MAX_LINES, MODULE_CARDS_MAX } from '../util/constants.js'

const DAY_MS = 86_400_000

export interface ModuleDataDeps {
  paths: Paths
  repo: CardRepository
  metrics: MetricsService
  flow: FlowService
  digest: DigestService
  supervision: Pick<SupervisionService, 'listStalledReviews'>
}

/**
 * Fachada somente leitura que os módulos recebem. Delega aos serviços do core
 * e devolve cópias/objetos novos — nada aqui expõe um caminho de escrita.
 */
export function createModuleDataApi(deps: ModuleDataDeps): ModuleDataApi {
  const { paths, repo } = deps
  return {
    metrics: (filter = {}) => deps.metrics.collect(filter),
    flow: (filter = {}) => deps.flow.collect(filter),
    digest: (opts) => deps.digest.collect(opts),
    stalledReviews: (project) => deps.supervision.listStalledReviews(project),

    async listProjects(opts = {}) {
      const out: ProjectInfo[] = []
      for (const name of await listProjectsSafe(paths)) {
        const meta = await loadProjectMetaOrNull(paths, name)
        if (!meta) continue
        if (meta.archived === true && !opts.includeArchived) continue
        out.push(toProjectInfo(name, meta))
      }
      return out
    },

    async getProject(name) {
      const meta = await loadProjectMetaOrNull(paths, name)
      return meta ? toProjectInfo(name, meta) : null
    },

    listCards(filter = {}) {
      return repo
        .query({
          ...(filter.project ? { project: filter.project } : {}),
          ...(filter.sprintId ? { sprintId: filter.sprintId } : {}),
          includeArchived: filter.includeArchived ?? false,
          orderBy: 'position',
          limit: MODULE_CARDS_MAX,
          offset: 0,
        })
        .map((row) => repo.toCard(row))
    },

    async moves(filter = {}) {
      const from = filter.from_date ? Date.parse(`${filter.from_date}T00:00:00.000Z`) : null
      const to = filter.to_date ? Date.parse(`${filter.to_date}T00:00:00.000Z`) + DAY_MS : null
      const moves: CardMove[] = []
      const { truncated } = await scanAuditLog(
        paths.auditLog,
        (e) => {
          if (e.op !== 'MOVE' || !e.card_id || !e.ts || !e.project) return
          if (filter.project && e.project !== filter.project) return
          const ms = Date.parse(e.ts)
          if (Number.isNaN(ms) || (from !== null && ms < from) || (to !== null && ms >= to)) return
          moves.push({
            ts: e.ts,
            project: e.project,
            card_id: e.card_id,
            from_status: e.from_status ?? '',
            to_status: e.to_status ?? '',
            actor: e.actor ?? null,
          })
        },
        DIGEST_AUDIT_MAX_LINES,
      )
      return { moves, truncated }
    },
  }
}

function toProjectInfo(name: string, meta: ProjectMeta): ProjectInfo {
  return {
    name,
    archived: meta.archived === true,
    columns: [...meta.columns],
    created_at: meta.created_at,
    target_repo: meta.target_repo ?? null,
    sprints: (meta.sprints ?? []).map((s) => ({ ...s })),
    goals: (meta.goals ?? []).map((g) => ({ ...g })),
    epics: (meta.epics ?? []).map((e) => ({ ...e, sprint_ids: [...e.sprint_ids] })),
  }
}
