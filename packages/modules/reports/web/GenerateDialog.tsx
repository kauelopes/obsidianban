import { useMemo, useState } from 'react'
import type { ModuleHost } from '@obsidiankan/module-sdk/web'
import type { GenerateRequest, ReportMeta, ReportOptions, ReportTypeId } from '../server/api-types.js'
import { fmtDateBr, localDate, type ReportsApi } from './api.js'
import { periodPresets } from './periods.js'

const SPRINT_STATUS = { planning: 'planejamento', active: 'ativa', closed: 'encerrada' } as const

/**
 * Pedido de relatório: tipo, alvo (projeto/sprint), período e análise por IA.
 * Dentro de um projeto o alvo vem travado e o tipo "board" some — ele é da
 * página global.
 */
export function GenerateDialog({
  host,
  api,
  options,
  project: fixedProject,
  onClose,
  onCreated,
}: {
  host: ModuleHost
  api: ReportsApi
  options: ReportOptions
  project?: string
  onClose: () => void
  onCreated: (meta: ReportMeta) => void
}) {
  const { Dialog } = host.ui
  const types = options.types.filter((t) => !fixedProject || t.id !== 'board')
  const [type, setType] = useState<ReportTypeId>(types[0]?.id ?? 'sprint')
  const info = types.find((t) => t.id === type)
  const needs = new Set(info?.needs ?? [])

  const projectNames = options.projects.map((p) => p.name)
  const [project, setProject] = useState(fixedProject ?? projectNames[0] ?? '')
  const sprints = options.projects.find((p) => p.name === project)?.sprints ?? []
  const defaultSprint = sprints.find((s) => s.status === 'active') ?? sprints[0]
  const [sprintId, setSprintId] = useState<string>('')
  const effectiveSprint = sprints.some((s) => s.id === sprintId) ? sprintId : (defaultSprint?.id ?? '')

  const presets = useMemo(() => periodPresets(localDate()), [])
  const [presetId, setPresetId] = useState('30d')
  const preset = presets.find((p) => p.id === presetId)
  const [custom, setCustom] = useState({ from: presets[1]!.from, to: presets[1]!.to })
  const period = preset ? { from: preset.from, to: preset.to } : custom

  const [analysis, setAnalysis] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const missing =
    (needs.has('project') && !project) ||
    (needs.has('sprint') && !effectiveSprint) ||
    (needs.has('period') && (!period.from || !period.to || period.from > period.to))

  async function submit() {
    setBusy(true)
    setError(null)
    const req: GenerateRequest = {
      type,
      include_analysis: analysis,
      ...(needs.has('project') ? { project } : {}),
      ...(needs.has('sprint') ? { sprint_id: effectiveSprint } : {}),
      ...(needs.has('period') ? { from: period.from, to: period.to } : {}),
    }
    const res = await api.generate(req)
    setBusy(false)
    if (!res.ok) {
      setError(res.error)
      return
    }
    onCreated(res.data)
  }

  const llmLabel = `${options.llm.provider}${options.llm.model ? ` · ${options.llm.model}` : ''}`

  return (
    <Dialog
      title="Gerar relatório"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="ghost" onClick={onClose}>
            cancelar
          </button>
          <button type="button" className="primary" disabled={busy || missing} onClick={() => void submit()}>
            {busy ? 'enviando…' : 'gerar'}
          </button>
        </>
      }
    >
      {error && <p className="banner">{error}</p>}

      <fieldset className="reports-field">
        <legend className="label">Tipo</legend>
        {types.map((t) => (
          <label key={t.id} className="reports-choice">
            <input type="radio" name="report-type" checked={type === t.id} onChange={() => setType(t.id)} />
            <span>
              <strong>{t.label}</strong>
              <span className="field-help">{t.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {needs.has('project') && !fixedProject && (
        <label className="reports-field">
          <span className="label">Projeto</span>
          <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Projeto">
            {projectNames.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}

      {needs.has('sprint') && (
        <label className="reports-field">
          <span className="label">Sprint</span>
          {sprints.length === 0 ? (
            <span className="field-help">Este projeto não tem sprints.</span>
          ) : (
            <select value={effectiveSprint} onChange={(e) => setSprintId(e.target.value)} aria-label="Sprint">
              {sprints.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {SPRINT_STATUS[s.status]}
                  {s.started_at ? ` · ${fmtDateBr(s.started_at)}${s.ended_at ? ` a ${fmtDateBr(s.ended_at)}` : ''}` : ''}
                </option>
              ))}
            </select>
          )}
        </label>
      )}

      {needs.has('period') && (
        <div className="reports-field">
          <span className="label">Período</span>
          <div className="reports-presets" role="radiogroup" aria-label="Período">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={presetId === p.id}
                className={presetId === p.id ? 'active' : undefined}
                onClick={() => setPresetId(p.id)}
              >
                {p.label}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={presetId === 'custom'}
              className={presetId === 'custom' ? 'active' : undefined}
              onClick={() => {
                setCustom(period)
                setPresetId('custom')
              }}
            >
              Personalizado
            </button>
          </div>
          {presetId === 'custom' ? (
            <div className="reports-range">
              <input type="date" aria-label="De" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
              <span>a</span>
              <input type="date" aria-label="Até" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </div>
          ) : (
            <span className="field-help">
              {fmtDateBr(period.from)} a {fmtDateBr(period.to)}
            </span>
          )}
        </div>
      )}

      <label className="reports-field reports-choice">
        <input type="checkbox" checked={analysis} onChange={(e) => setAnalysis(e.target.checked)} />
        <span>
          <strong>Incluir análise por IA</strong>
          <span className="field-help">
            Resumo, destaques, riscos e recomendações escritos por {llmLabel} a partir dos números do relatório. Leva
            mais tempo e consome uso do LLM.
          </span>
        </span>
      </label>

      {!options.renderer.available && (
        <p className="field-help reports-warn">
          PDF indisponível neste servidor ({options.renderer.reason}). O relatório sai em Markdown.
        </p>
      )}
    </Dialog>
  )
}
