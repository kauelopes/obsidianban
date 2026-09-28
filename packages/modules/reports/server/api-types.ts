// Tipos da API do módulo de relatórios — puros (sem runtime), importados
// também pela parte web. Um relatório é um `ReportDocument`: a mesma estrutura
// alimenta o Markdown (web/Obsidian) e o PDF (renderer Python), então as duas
// saídas nunca divergem em número.

export type ReportTypeId = 'sprint' | 'project' | 'board'

export type ReportStatus = 'queued' | 'collecting' | 'analyzing' | 'rendering' | 'done' | 'failed'

/** Parâmetros de geração, já validados. Datas YYYY-MM-DD, `to` inclusivo. */
export interface ReportParams {
  type: ReportTypeId
  project: string | null
  sprint_id: string | null
  from: string | null
  to: string | null
  include_analysis: boolean
}

export type PdfStatus = 'pending' | 'ready' | 'unavailable' | 'failed'
export type AnalysisStatus = 'skipped' | 'pending' | 'done' | 'failed'

export interface ReportMeta {
  id: string
  type: ReportTypeId
  title: string
  params: ReportParams
  status: ReportStatus
  /** Período efetivo coberto (resolvido a partir da sprint quando for o caso). */
  period: { from: string; to: string } | null
  created_at: string
  created_by: string
  finished_at: string | null
  error: string | null
  pdf: { status: PdfStatus; error: string | null; bytes: number | null }
  analysis: {
    status: AnalysisStatus
    provider: string | null
    model: string | null
    error: string | null
    usage: { input: number; output: number; usd: number } | null
  }
  /** Avisos sobre os dados (audit truncado, custo não medido na época…). */
  warnings: string[]
}

export interface ReportTypeInfo {
  id: ReportTypeId
  label: string
  description: string
  /** Campos que o diálogo precisa pedir. */
  needs: Array<'project' | 'sprint' | 'period'>
}

export interface ReportOptions {
  types: ReportTypeInfo[]
  projects: Array<{
    name: string
    sprints: Array<{ id: string; name: string; status: 'planning' | 'active' | 'closed'; started_at: string | null; ended_at: string | null }>
  }>
  renderer: RendererStatus
  llm: { provider: string; model: string | null }
}

export interface RendererStatus {
  available: boolean
  python: string
  /** Motivo quando indisponível (python ausente, weasyprint não instalado…). */
  reason: string | null
}

export interface GenerateRequest {
  type: ReportTypeId
  project?: string
  sprint_id?: string
  from?: string
  to?: string
  include_analysis?: boolean
}

export interface ReportListResponse {
  reports: ReportMeta[]
}

export interface ReportMarkdownResponse {
  id: string
  markdown: string
}

/** Payload do evento SSE `progress` (MODULE_EVENT do módulo reports). */
export interface ReportProgressEvent {
  id: string
  status: ReportStatus
  project: string | null
}

// ─── Documento ───────────────────────────────────────────────────────────────

export type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'kpis'; items: Array<{ label: string; value: string; hint?: string }> }
  | {
      kind: 'table'
      columns: string[]
      rows: string[][]
      /** Índices das colunas numéricas (alinhadas à direita). */
      numeric?: number[]
      caption?: string
    }
  | {
      kind: 'chart'
      chart: 'bar' | 'line'
      title: string
      labels: string[]
      series: Array<{ name: string; values: number[] }>
      /** Sufixo do valor no rótulo, ex.: ' h', ' US$'. */
      unit?: string
    }
  | { kind: 'callout'; title: string; text: string; tone: 'info' | 'warn' }
  | { kind: 'list'; items: string[] }
  | { kind: 'analysis'; markdown: string; provider: string; model: string | null; generated_at: string }

export interface ReportSection {
  title: string
  lead?: string
  blocks: Block[]
}

export interface ReportDocument {
  /** Rótulo do tipo, vai na capa (ex.: "Relatório de sprint"). */
  kicker: string
  title: string
  subtitle: string
  period: { from: string; to: string }
  generated_at: string
  sections: ReportSection[]
  /** Metodologia e ressalvas — fecham o documento. */
  notes: string[]
}
