import { ModuleHttpError, type ModuleContext, type ServerModule } from '@obsidiankan/module-sdk'
import type {
  GenerateRequest,
  ReportListResponse,
  ReportMarkdownResponse,
  ReportMeta,
  ReportOptions,
  ReportTypeId,
} from './api-types.js'
import { PdfRenderer, defaultRendererDir, resolvePython, type PdfRendererLike, type ReportTheme } from './pdf.js'
import { ReportRunner } from './pipeline.js'
import { ReportStore } from './store.js'
import { REPORT_TYPES } from './types/index.js'
import { badRequest } from './types/common.js'
import { fmtPeriod } from './format.js'

export type { ReportTheme } from './pdf.js'
export * from './api-types.js'

export interface ReportsModuleOptions {
  /** Injeção para testes; em produção o renderer Python do próprio pacote. */
  pdf?: PdfRendererLike
  now?: () => Date
}

/**
 * Relatórios de sprint, de projeto e do board inteiro. Dados via fachada
 * somente leitura do core, análise opcional pelo LLM do contexto, saída em
 * Markdown (interface/Obsidian) e PDF (WeasyPrint).
 */
export function createReportsModule(opts: ReportsModuleOptions = {}): ServerModule & { runner(): ReportRunner | null } {
  let runner: ReportRunner | null = null
  return {
    id: 'reports',
    name: 'Relatórios',
    version: '0.1.0',
    description: 'Relatórios de sprint, de projeto e do board, com números calculados, análise opcional por IA e PDF.',
    runner: () => runner,
    async register(ctx: ModuleContext) {
      const store = new ReportStore(ctx.dataDir)
      const rendererDir = ctx.env['REPORTS_RENDERER_DIR'] ?? defaultRendererDir()
      const pdf = opts.pdf ?? new PdfRenderer(resolvePython(ctx.env, rendererDir), rendererDir)
      const now = opts.now ?? (() => new Date())
      runner = new ReportRunner({
        store,
        types: REPORT_TYPES,
        data: ctx.data,
        llm: ctx.llm,
        pdf,
        theme: () => themeFrom(ctx.settings().config),
        emit: (event, payload) => ctx.events.emit(event, payload),
        logger: ctx.logger,
        now,
      })
      const recovered = await runner.recover()
      if (recovered > 0) ctx.logger.warn({ recovered }, 'reports: relatórios interrompidos marcados como failed')
      registerRoutes(ctx, store, runner, pdf, now)
    },
  }
}

export const reportsModule = createReportsModule()

function registerRoutes(ctx: ModuleContext, store: ReportStore, runner: ReportRunner, pdf: PdfRendererLike, now: () => Date): void {
  const { routes, data } = ctx

  routes.register('GET', '/options', 'bearer', async () => {
    const projects = await data.listProjects()
    const body: ReportOptions = {
      types: [...REPORT_TYPES.values()].map((t) => t.info),
      projects: projects.map((p) => ({
        name: p.name,
        sprints: [...p.sprints]
          .sort((a, b) => (b.started_at ?? b.created_at).localeCompare(a.started_at ?? a.created_at))
          .map((s) => ({ id: s.id, name: s.name, status: s.status, started_at: s.started_at, ended_at: s.ended_at })),
      })),
      renderer: await pdf.status(),
      llm: { provider: ctx.llm.id, model: ctx.llm.model },
    }
    return { json: body }
  })

  routes.register('GET', '/', 'bearer', async (req) => {
    const project = req.query.get('project')
    const type = req.query.get('type')
    const reports = (await store.list()).filter(
      (r) => (!project || r.params.project === project) && (!type || r.type === type),
    )
    const body: ReportListResponse = { reports }
    return { json: body }
  })

  routes.register('POST', '/', 'pm', async (req) => {
    const body = (req.body ?? {}) as GenerateRequest
    const type = REPORT_TYPES.get(body.type as ReportTypeId)
    if (!type) throw badRequest('invalid_field', { field: 'type', expected: [...REPORT_TYPES.keys()].join('|') })
    if (body.include_analysis !== undefined && typeof body.include_analysis !== 'boolean') {
      throw badRequest('invalid_field', { field: 'include_analysis', expected: 'boolean' })
    }
    const params = await type.resolve(body, { data, now: now() })
    const meta = await runner.submit(params, req.claims?.actor ?? 'desconhecido', await titleFor(params, ctx))
    return { status: 202, json: meta }
  })

  routes.register('GET', '/:id', 'bearer', async (req) => ({ json: await mustLoad(store, req.params['id']!) }))

  routes.register('GET', '/:id/markdown', 'bearer', async (req) => {
    const meta = await mustLoad(store, req.params['id']!)
    const md = await store.read(meta.id, 'report.md')
    if (!md) throw new ModuleHttpError(409, { error: 'not_ready', status: meta.status })
    const body: ReportMarkdownResponse = { id: meta.id, markdown: md.toString('utf8') }
    return { json: body }
  })

  routes.register('GET', '/:id/pdf', 'bearer', async (req) => {
    const meta = await mustLoad(store, req.params['id']!)
    const file = meta.pdf.status === 'ready' ? await store.read(meta.id, 'report.pdf') : null
    if (!file) throw new ModuleHttpError(409, { error: 'pdf_not_ready', pdf: meta.pdf })
    return { file: { data: file, contentType: 'application/pdf', filename: `${fileSlug(meta)}.pdf` } }
  })

  routes.register('POST', '/:id/pdf', 'pm', async (req) => {
    const meta = await mustLoad(store, req.params['id']!)
    if (meta.status !== 'done') throw new ModuleHttpError(409, { error: 'not_ready', status: meta.status })
    return { json: await runner.rerenderPdf(meta) }
  })

  routes.register('DELETE', '/:id', 'pm', async (req) => {
    const meta = await mustLoad(store, req.params['id']!)
    if (runner.isBusy(meta.id)) throw new ModuleHttpError(409, { error: 'report_running' })
    await store.remove(meta.id)
    return { json: { deleted: meta.id } }
  })
}

async function mustLoad(store: ReportStore, id: string): Promise<ReportMeta> {
  const meta = await store.loadMeta(id)
  if (!meta) throw new ModuleHttpError(404, { error: 'report_not_found', id })
  return meta
}

async function titleFor(p: { type: ReportTypeId; project: string | null; sprint_id: string | null; from: string | null; to: string | null }, ctx: ModuleContext): Promise<string> {
  if (p.type === 'sprint') {
    const project = p.project ? await ctx.data.getProject(p.project) : null
    const sprint = project?.sprints.find((s) => s.id === p.sprint_id)
    return `Sprint ${sprint?.name ?? p.sprint_id} · ${p.project}`
  }
  const period = fmtPeriod({ from: p.from!, to: p.to! })
  if (p.type === 'project') return `Projeto ${p.project} · ${period}`
  return `Board · ${period}`
}

function fileSlug(meta: ReportMeta): string {
  const base = meta.title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `relatorio-${base || meta.type}-${meta.created_at.slice(0, 10)}`
}

function themeFrom(config: Record<string, unknown>): ReportTheme {
  const raw = config['theme']
  if (typeof raw !== 'object' || raw === null) return {}
  const t = raw as Record<string, unknown>
  const pick = (k: keyof ReportTheme) => (typeof t[k] === 'string' && (t[k] as string).trim() ? (t[k] as string).trim() : undefined)
  const theme: ReportTheme = {}
  for (const k of ['brand', 'tagline', 'site', 'footer', 'document_type'] as const) {
    const v = pick(k)
    if (v) theme[k] = v
  }
  return theme
}
