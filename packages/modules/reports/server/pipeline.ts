import type { LlmProvider, ModuleDataApi, ModuleLogger } from '@obsidiankan/module-sdk'
import type { Block, ReportDocument, ReportMeta, ReportParams, ReportProgressEvent, ReportStatus } from './api-types.js'
import { runAnalysis } from './analysis.js'
import { toMarkdown } from './markdown.js'
import type { PdfRendererLike, ReportTheme } from './pdf.js'
import type { ReportStore } from './store.js'
import type { ReportTypeDef } from './types/common.js'

export interface RunnerDeps {
  store: ReportStore
  types: ReadonlyMap<string, ReportTypeDef>
  data: ModuleDataApi
  llm: LlmProvider
  pdf: PdfRendererLike
  theme: () => ReportTheme
  emit: (event: 'progress', payload: ReportProgressEvent) => void
  logger: ModuleLogger
  now?: () => Date
}

const TERMINAL: ReadonlySet<ReportStatus> = new Set(['done', 'failed'])

/**
 * Geração em segundo plano, um relatório por vez (fila FIFO): coleta os dados,
 * pede a análise (opcional), grava MD e tenta o PDF. Cada transição vai para o
 * report.json e sai como evento `progress`, então a interface acompanha ao
 * vivo e um reload no meio não perde nada.
 */
export class ReportRunner {
  private readonly queue: string[] = []
  private running: Promise<void> | null = null
  private readonly now: () => Date

  constructor(private readonly deps: RunnerDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /** Relatórios que estavam em andamento quando o servidor caiu não retomam: viram failed. */
  async recover(): Promise<number> {
    let n = 0
    for (const meta of await this.deps.store.list()) {
      if (TERMINAL.has(meta.status)) continue
      await this.deps.store.saveMeta({
        ...meta,
        status: 'failed',
        error: 'interrompido: o servidor reiniciou durante a geração — gere de novo',
        finished_at: this.now().toISOString(),
      })
      n++
    }
    return n
  }

  async submit(params: ReportParams, actor: string, title: string): Promise<ReportMeta> {
    const now = this.now()
    const meta: ReportMeta = {
      id: this.deps.store.newId(now),
      type: params.type,
      title,
      params,
      status: 'queued',
      period: params.from && params.to ? { from: params.from, to: params.to } : null,
      created_at: now.toISOString(),
      created_by: actor,
      finished_at: null,
      error: null,
      pdf: { status: 'pending', error: null, bytes: null },
      analysis: {
        status: params.include_analysis ? 'pending' : 'skipped',
        provider: params.include_analysis ? this.deps.llm.id : null,
        model: params.include_analysis ? this.deps.llm.model : null,
        error: null,
        usage: null,
      },
      warnings: [],
    }
    await this.deps.store.saveMeta(meta)
    this.emit(meta)
    this.queue.push(meta.id)
    this.kick()
    return meta
  }

  /** Espera a fila esvaziar — usado em testes e no shutdown. */
  async idle(): Promise<void> {
    while (this.running) await this.running
  }

  isBusy(id: string): boolean {
    return this.queue.includes(id) || this.current === id
  }

  /** Refaz só o PDF de um relatório pronto (ex.: depois de instalar o renderer). */
  async rerenderPdf(meta: ReportMeta): Promise<ReportMeta> {
    const doc = await this.deps.store.loadDocument(meta.id)
    if (!doc) throw new Error('documento do relatório ausente')
    let next: ReportMeta = { ...meta, pdf: { status: 'pending', error: null, bytes: null } }
    await this.deps.store.saveMeta(next)
    next = await this.renderPdf(next, doc)
    await this.deps.store.saveMeta(next)
    this.emit(next)
    return next
  }

  private current: string | null = null

  private kick(): void {
    if (this.running) return
    this.running = (async () => {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!
        this.current = id
        try {
          await this.process(id)
        } catch (err) {
          this.deps.logger.error({ err, report: id }, 'reports: geração falhou')
          const meta = await this.deps.store.loadMeta(id)
          if (meta) await this.update(meta, { status: 'failed', error: (err as Error).message, finished_at: this.now().toISOString() })
        } finally {
          this.current = null
        }
      }
      this.running = null
    })()
  }

  private async process(id: string): Promise<void> {
    let meta = await this.deps.store.loadMeta(id)
    if (!meta) return
    const type = this.deps.types.get(meta.type)
    if (!type) throw new Error(`tipo de relatório desconhecido: ${meta.type}`)

    meta = await this.update(meta, { status: 'collecting' })
    const built = await type.build(meta.params, { data: this.deps.data, now: this.now() })
    const doc = built.document
    meta = await this.update(meta, { warnings: built.warnings, period: doc.period })

    if (meta.params.include_analysis) {
      meta = await this.update(meta, { status: 'analyzing' })
      const out = await runAnalysis(this.deps.llm, doc, built.facts)
      const usage = out.completion ? out.completion.usage : null
      if (out.ok) {
        insertAnalysis(doc, {
          kind: 'analysis',
          markdown: out.markdown,
          provider: this.deps.llm.id,
          model: this.deps.llm.model,
          generated_at: this.now().toISOString(),
        })
        meta = await this.update(meta, { analysis: { ...meta.analysis, status: 'done', usage } })
      } else {
        // Sem análise o relatório ainda vale: os números estão todos lá.
        doc.notes.push(`A análise por IA foi pedida mas falhou: ${out.error}.`)
        meta = await this.update(meta, { analysis: { ...meta.analysis, status: 'failed', error: out.error, usage } })
      }
    }

    meta = await this.update(meta, { status: 'rendering' })
    await this.deps.store.saveDocument(id, doc)
    await this.deps.store.saveMarkdown(id, toMarkdown(doc))
    meta = await this.renderPdf(meta, doc)
    await this.update(meta, { status: 'done', finished_at: this.now().toISOString() })
  }

  private async renderPdf(meta: ReportMeta, doc: ReportDocument): Promise<ReportMeta> {
    const res = await this.deps.pdf.render(doc, this.deps.theme(), this.deps.store.file(meta.id, 'report.pdf'))
    if (!res.ok) {
      const st = await this.deps.pdf.status()
      return { ...meta, pdf: { status: st.available ? 'failed' : 'unavailable', error: res.error, bytes: null } }
    }
    const pdf = await this.deps.store.read(meta.id, 'report.pdf')
    return { ...meta, pdf: { status: 'ready', error: null, bytes: pdf?.byteLength ?? null } }
  }

  private async update(meta: ReportMeta, patch: Partial<ReportMeta>): Promise<ReportMeta> {
    const next = { ...meta, ...patch }
    await this.deps.store.saveMeta(next)
    if (patch.status && patch.status !== meta.status) this.emit(next)
    return next
  }

  private emit(meta: ReportMeta): void {
    this.deps.emit('progress', { id: meta.id, status: meta.status, project: meta.params.project })
  }
}

/** A análise entra logo depois do Resumo — é a leitura dos números que vêm a seguir. */
function insertAnalysis(doc: ReportDocument, block: Extract<Block, { kind: 'analysis' }>): void {
  const section = { title: 'Análise', lead: 'Interpretação gerada por IA a partir dos números deste relatório.', blocks: [block] }
  const at = doc.sections.findIndex((s) => s.title === 'Resumo')
  doc.sections.splice(at >= 0 ? at + 1 : 0, 0, section)
}
