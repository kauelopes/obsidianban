import { useState } from 'react'
import type {
  PlanningChoicePayload,
  PlanningConfirmPayload,
  PlanningDiagramPayload,
  PlanningFormPayload,
  PlanningListItem,
  PlanningListPayload,
} from '@obsidiankan/types'
import { Markdown } from '../markdown/Markdown.js'

/**
 * As cinco telas do wizard. Todas recebem o payload gerado (ou estático) do
 * servidor e devolvem a resposta humana no formato que o servidor espera:
 * form → {campo: valor}, choice → {choice}, list → {items},
 * diagram/confirm → {approved: true}; correções vão por onRefine.
 */

export function StepForm({
  payload,
  busy,
  onSubmit,
}: {
  payload: PlanningFormPayload
  busy: boolean
  onSubmit: (answer: Record<string, string>) => void
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(payload.fields.map((f) => [f.id, f.value ?? ''])),
  )
  const filled = payload.fields.every((f) => (values[f.id] ?? '').trim() !== '' || f.id === 'target_repo')
  return (
    <div className="form">
      {payload.fields.map((f) => (
        <label key={f.id}>
          <span>{f.label}</span>
          <textarea
            rows={f.id === 'name' || f.id === 'target_repo' ? 1 : 5}
            value={values[f.id] ?? ''}
            onChange={(e) => setValues((v) => ({ ...v, [f.id]: e.target.value }))}
          />
          {f.help && <span className="field-help">{f.help}</span>}
        </label>
      ))}
      <div className="form-row">
        <div className="spacer" />
        <button className="primary" disabled={busy || !filled} onClick={() => onSubmit(values)}>
          Continuar
        </button>
      </div>
    </div>
  )
}

export function StepChoice({
  payload,
  busy,
  onSubmit,
}: {
  payload: PlanningChoicePayload
  busy: boolean
  onSubmit: (answer: { choice: string }) => void
}) {
  const [choice, setChoice] = useState<string>(payload.suggested ?? '')
  const [custom, setCustom] = useState('')
  const value = choice === '__custom' ? custom.trim() : choice
  return (
    <div className="form">
      <p>{payload.question}</p>
      <div className="wizard-options" role="radiogroup" aria-label={payload.question}>
        {payload.options.map((o) => (
          <label key={o.id} className={`wizard-option${choice === o.id ? ' selected' : ''}`}>
            <input
              type="radio"
              name="choice"
              checked={choice === o.id}
              onChange={() => setChoice(o.id)}
            />
            <span>{o.label}</span>
            {o.description && <span className="field-help">{o.description}</span>}
          </label>
        ))}
        <label className={`wizard-option${choice === '__custom' ? ' selected' : ''}`}>
          <input
            type="radio"
            name="choice"
            checked={choice === '__custom'}
            onChange={() => setChoice('__custom')}
          />
          <span>outro:</span>
          <input
            type="text"
            value={custom}
            onFocus={() => setChoice('__custom')}
            onChange={(e) => setCustom(e.target.value)}
          />
        </label>
      </div>
      <div className="form-row">
        <div className="spacer" />
        <button className="primary" disabled={busy || !value} onClick={() => onSubmit({ choice: value })}>
          Continuar
        </button>
      </div>
    </div>
  )
}

export function StepList({
  payload,
  busy,
  onSubmit,
}: {
  payload: PlanningListPayload
  busy: boolean
  onSubmit: (answer: { items: PlanningListItem[] }) => void
}) {
  const [items, setItems] = useState<PlanningListItem[]>(payload.items)
  const patch = (i: number, p: Partial<PlanningListItem>) =>
    setItems((prev) => prev.map((it, j) => (j === i ? { ...it, ...p } : it)))
  return (
    <div className="form">
      {payload.intro && <p>{payload.intro}</p>}
      {items.map((it, i) => (
        <div key={it.id} className="wizard-list-item">
          <input
            aria-label="título do item"
            value={it.title}
            onChange={(e) => patch(i, { title: e.target.value })}
          />
          <textarea
            aria-label="detalhe do item"
            rows={2}
            value={it.detail ?? ''}
            onChange={(e) => patch(i, { detail: e.target.value })}
          />
          <button
            className="danger"
            aria-label={`remover ${it.title}`}
            onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
          >
            remover
          </button>
        </div>
      ))}
      <div className="form-row">
        {/* borda de botão de verdade: ghost lia como texto solto */}
        <button
          onClick={() =>
            setItems((prev) => [...prev, { id: `novo-${prev.length + 1}`, title: '', detail: '' }])
          }
        >
          + adicionar item
        </button>
        <div className="spacer" />
        <button
          className="primary"
          disabled={busy || items.length === 0 || items.some((i) => !i.title.trim())}
          onClick={() => onSubmit({ items })}
        >
          Continuar
        </button>
      </div>
    </div>
  )
}

/** Caixa de correção compartilhada por diagram e confirm. */
function RefineBox({
  busy,
  onRefine,
  placeholder,
}: {
  busy: boolean
  onRefine: (feedback: string) => void
  placeholder: string
}) {
  const [feedback, setFeedback] = useState('')
  return (
    <div className="wizard-refine">
      <textarea
        rows={2}
        value={feedback}
        placeholder={placeholder}
        aria-label="pedir correção"
        onChange={(e) => setFeedback(e.target.value)}
      />
      <button
        disabled={busy || !feedback.trim()}
        onClick={() => {
          onRefine(feedback.trim())
          setFeedback('')
        }}
      >
        corrigir
      </button>
    </div>
  )
}

export function StepDiagram({
  payload,
  busy,
  onSubmit,
  onRefine,
}: {
  payload: PlanningDiagramPayload
  busy: boolean
  onSubmit: (answer: { approved: true }) => void
  onRefine: (feedback: string) => void
}) {
  return (
    <div className="wizard-generated">
      <Markdown prose>{`\`\`\`mermaid\n${payload.mermaid}\n\`\`\``}</Markdown>
      {payload.caption && <p className="field-help">{payload.caption}</p>}
      <RefineBox
        busy={busy}
        onRefine={onRefine}
        placeholder="algo errado no diagrama? descreva e eu corrijo"
      />
      <div className="form-row wizard-cta">
        <div className="spacer" />
        <button className="primary" disabled={busy} onClick={() => onSubmit({ approved: true })}>
          Confirmar e continuar
        </button>
      </div>
    </div>
  )
}

export function StepConfirm({
  payload,
  busy,
  confirmLabel = 'Confirmar e continuar',
  onSubmit,
  onRefine,
}: {
  payload: PlanningConfirmPayload
  busy: boolean
  confirmLabel?: string
  onSubmit: (answer: { approved: true }) => void
  onRefine: (feedback: string) => void
}) {
  return (
    <div className="wizard-generated">
      <Markdown prose>{payload.markdown}</Markdown>
      <RefineBox
        busy={busy}
        onRefine={onRefine}
        placeholder="algo a ajustar? descreva e eu corrijo"
      />
      {/* sticky: o markdown gerado pode ser longo — o CTA não some no scroll */}
      <div className="form-row wizard-cta">
        <div className="spacer" />
        <button className="primary" disabled={busy} onClick={() => onSubmit({ approved: true })}>
          {confirmLabel}
        </button>
      </div>
    </div>
  )
}
