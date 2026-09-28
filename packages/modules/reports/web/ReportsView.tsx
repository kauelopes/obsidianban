import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModuleHost } from '@obsidiankan/module-sdk/web'
import type { ReportMeta, ReportOptions, ReportProgressEvent } from '../server/api-types.js'
import { ReportsApi, STATUS_LABEL, fmtDateBr, saveBlob } from './api.js'
import { GenerateDialog } from './GenerateDialog.js'

const TYPE_LABEL = { sprint: 'Sprint', project: 'Projeto', board: 'Board' } as const

/**
 * Lista de relatórios + visualizador. Na página global mostra tudo; dentro de
 * um projeto, só os dele. O progresso chega por SSE (`progress`), então um
 * relatório em geração vira "pronto" na tela sem recarregar.
 */
export function ReportsView({ host, project }: { host: ModuleHost; project?: string }) {
  const api = useMemo(() => new ReportsApi(host), [host])
  const { Markdown } = host.ui

  const [reports, setReports] = useState<ReportMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [options, setOptions] = useState<ReportOptions | null>(null)
  const [creating, setCreating] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [content, setContent] = useState<{ id: string; markdown: string } | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const res = await api.list(project)
    setLoading(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    setError(null)
    setReports(res.data)
  }, [api, project])

  useEffect(() => {
    setSelectedId(null)
    setContent(null)
    void reload()
  }, [reload])

  useEffect(
    () =>
      host.api.onEvent((event, payload) => {
        if (event !== 'progress') return
        const p = payload as ReportProgressEvent
        if (!project || p.project === project) void reload()
      }),
    [host, project, reload],
  )

  const selected = reports.find((r) => r.id === selectedId) ?? null

  // Carrega o Markdown quando o selecionado fica pronto (inclusive ao vivo).
  useEffect(() => {
    if (!selected || selected.status !== 'done' || content?.id === selected.id) return
    let alive = true
    void api.markdown(selected.id).then((res) => {
      if (!alive) return
      if (res.ok) setContent({ id: selected.id, markdown: res.data })
      else setActionError(res.error)
    })
    return () => {
      alive = false
    }
  }, [api, selected, content])

  async function openGenerate() {
    setActionError(null)
    const res = await api.options()
    if (!res.ok) {
      setActionError(res.error)
      return
    }
    setOptions(res.data)
    setCreating(true)
  }

  async function downloadPdf(meta: ReportMeta) {
    setBusy('pdf')
    const res = await api.pdf(meta.id)
    setBusy(null)
    if (!res.ok) setActionError(res.error)
    else saveBlob(res.data.blob, res.data.filename)
  }

  function downloadMd() {
    if (!content || !selected) return
    saveBlob(new Blob([content.markdown], { type: 'text/markdown;charset=utf-8' }), `${selected.id}.md`)
  }

  async function retryPdf(meta: ReportMeta) {
    setBusy('retry')
    setActionError(null)
    const res = await api.rerenderPdf(meta.id)
    setBusy(null)
    if (!res.ok) setActionError(res.error)
    await reload()
  }

  async function remove(meta: ReportMeta) {
    setBusy('delete')
    const res = await api.remove(meta.id)
    setBusy(null)
    if (!res.ok) {
      setActionError(res.error)
      return
    }
    setSelectedId(null)
    setContent(null)
    await reload()
  }

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head reports-head">
          <div>
            <h1>Relatórios</h1>
            <div className="detail-ident">
              <span>{project ? `do projeto ${project}` : 'de todos os projetos e do board'}</span>
            </div>
          </div>
          <button type="button" className="primary" onClick={() => void openGenerate()}>
            gerar relatório
          </button>
        </div>

        {error && <p className="banner">{error}</p>}
        {actionError && (
          <p className="banner">
            {actionError}
            <button className="ghost" onClick={() => setActionError(null)}>
              fechar
            </button>
          </p>
        )}

        <div className="home-grid">
          <aside className="home-side">
            {loading ? (
              <p className="empty-lg">carregando relatórios…</p>
            ) : reports.length === 0 ? (
              <p className="empty-lg">Nenhum relatório ainda. Use “gerar relatório”.</p>
            ) : (
              <ul className="pending reports-list">
                {reports.map((r) => (
                  <li key={r.id}>
                    <a
                      className={r.id === selectedId ? 'active' : undefined}
                      onClick={() => {
                        setActionError(null)
                        setSelectedId(r.id)
                      }}
                    >
                      <strong>{r.title}</strong>
                      <span className="where">
                        {TYPE_LABEL[r.type]} · {fmtDateBr(r.created_at)}
                      </span>
                      <span className={`pill ${statusClass(r)}`}>{STATUS_LABEL[r.status]}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <main className="home-main">
            {!selected ? (
              <p className="empty-lg">Selecione um relatório.</p>
            ) : (
              <>
                <div className="report-toolbar">
                  <span className={`pill ${statusClass(selected)}`}>{STATUS_LABEL[selected.status]}</span>
                  {selected.status === 'done' && selected.pdf.status === 'ready' && (
                    <button type="button" disabled={busy === 'pdf'} onClick={() => void downloadPdf(selected)}>
                      baixar PDF
                    </button>
                  )}
                  {selected.status === 'done' && content?.id === selected.id && (
                    <button type="button" onClick={downloadMd}>
                      baixar .md
                    </button>
                  )}
                  {selected.status === 'done' && (selected.pdf.status === 'unavailable' || selected.pdf.status === 'failed') && (
                    <button type="button" disabled={busy === 'retry'} onClick={() => void retryPdf(selected)}>
                      tentar PDF de novo
                    </button>
                  )}
                  {(selected.status === 'done' || selected.status === 'failed') && (
                    <button type="button" className="ghost" disabled={busy === 'delete'} onClick={() => void remove(selected)}>
                      excluir
                    </button>
                  )}
                </div>

                {selected.status === 'done' && selected.pdf.status !== 'ready' && selected.pdf.error && (
                  <p className="field-help reports-warn">PDF {selected.pdf.status === 'unavailable' ? 'indisponível' : 'falhou'}: {selected.pdf.error}</p>
                )}
                {selected.analysis.status === 'failed' && (
                  <p className="field-help reports-warn">Análise por IA falhou: {selected.analysis.error}</p>
                )}

                {selected.status === 'failed' ? (
                  <p className="banner">Falhou: {selected.error}</p>
                ) : selected.status !== 'done' ? (
                  <Progress meta={selected} />
                ) : content?.id === selected.id ? (
                  <Markdown prose>{content.markdown}</Markdown>
                ) : (
                  <p className="empty-lg">carregando relatório…</p>
                )}
              </>
            )}
          </main>
        </div>
      </div>

      {creating && options && (
        <GenerateDialog
          host={host}
          api={api}
          options={options}
          {...(project ? { project } : {})}
          onClose={() => setCreating(false)}
          onCreated={(meta) => {
            setCreating(false)
            setSelectedId(meta.id)
            void reload()
          }}
        />
      )}
    </div>
  )
}

const STEPS = ['queued', 'collecting', 'analyzing', 'rendering', 'done'] as const

function Progress({ meta }: { meta: ReportMeta }) {
  const steps = STEPS.filter((s) => s !== 'analyzing' || meta.params.include_analysis)
  const at = steps.indexOf(meta.status as (typeof STEPS)[number])
  return (
    <ol className="report-progress" aria-label="Progresso da geração">
      {steps.slice(0, -1).map((s, i) => (
        <li key={s} className={i < at ? 'done' : i === at ? 'current' : undefined}>
          {STATUS_LABEL[s]}
        </li>
      ))}
    </ol>
  )
}

function statusClass(r: ReportMeta): string {
  if (r.status === 'done') return 'active'
  if (r.status === 'failed') return 'wf-failed'
  return 'wf-running'
}
