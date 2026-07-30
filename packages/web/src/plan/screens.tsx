import { useState } from 'react'
import type {
  PlanningChoicePayload,
  PlanningConfirmPayload,
  PlanningDiagramPayload,
  PlanningFormPayload,
  PlanningListItem,
  PlanningListPayload,
  PlanningTaskItem,
  PlanningTaskListPayload,
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

const TASK_TYPES = ['task', 'feature', 'bug', 'chore'] as const
const TASK_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const

export function StepTaskList({
  payload,
  busy,
  onSubmit,
  onRefine,
}: {
  payload: PlanningTaskListPayload
  busy: boolean
  onSubmit: (answer: { tasks: Array<Omit<PlanningTaskItem, 'id'>> }) => void
  onRefine: (feedback: string) => void
}) {
  const [tasks, setTasks] = useState<PlanningTaskItem[]>(payload.tasks ?? [])
  const patch = (i: number, p: Partial<PlanningTaskItem>) =>
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, ...p } : t)))
  const addTag = (i: number, tag: string) =>
    setTasks((prev) =>
      prev.map((t, j) =>
        j === i && !(t.tags ?? []).includes(tag) ? { ...t, tags: [...(t.tags ?? []), tag] } : t,
      ),
    )
  const removeTag = (i: number, tag: string) =>
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, tags: (t.tags ?? []).filter((x) => x !== tag) } : t)))

  return (
    <div className="form">
      {payload.intro && <p>{payload.intro}</p>}
      {tasks.map((t, i) => (
        <div key={t.id} className="wizard-task-item">
          <input
            aria-label="título da tarefa"
            value={t.title}
            onChange={(e) => patch(i, { title: e.target.value })}
          />
          <div className="form-row">
            <label>
              <span>Tipo</span>
              <select value={t.type} onChange={(e) => patch(i, { type: e.target.value as PlanningTaskItem['type'] })}>
                {TASK_TYPES.map((tp) => (
                  <option key={tp} value={tp}>
                    {tp}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Prioridade</span>
              <select
                value={t.priority ?? 'medium'}
                onChange={(e) => patch(i, { priority: e.target.value as PlanningTaskItem['priority'] })}
              >
                {TASK_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <textarea
            aria-label="corpo da tarefa"
            rows={3}
            value={t.body ?? ''}
            onChange={(e) => patch(i, { body: e.target.value })}
          />
          <div className="chips">
            {(t.tags ?? []).map((tag) => (
              <span className="chip" key={tag}>
                #{tag}
                <button type="button" onClick={() => removeTag(i, tag)}>
                  ×
                </button>
              </span>
            ))}
            <TagInput onAdd={(tag) => addTag(i, tag)} />
          </div>
          <button
            className="danger"
            aria-label={`remover ${t.title}`}
            onClick={() => setTasks((prev) => prev.filter((_, j) => j !== i))}
          >
            remover
          </button>
        </div>
      ))}
      <div className="form-row">
        <button
          onClick={() =>
            setTasks((prev) => [
              ...prev,
              { id: `nova-${prev.length + 1}`, title: '', type: 'task', priority: 'medium' },
            ])
          }
        >
          + adicionar tarefa
        </button>
        <div className="spacer" />
      </div>
      <RefineBox
        busy={busy}
        onRefine={onRefine}
        placeholder="algo errado nas tarefas sugeridas? descreva e eu regenero"
      />
      <div className="form-row wizard-cta">
        <div className="spacer" />
        <button
          className="primary"
          disabled={busy || tasks.length === 0 || tasks.some((t) => !t.title.trim())}
          onClick={() =>
            onSubmit({
              tasks: tasks.map(({ id: _id, body, ...rest }) => ({
                ...rest,
                ...(body?.trim() ? { body } : {}),
              })),
            })
          }
        >
          Confirmar e continuar
        </button>
      </div>
    </div>
  )
}

function TagInput({ onAdd }: { onAdd: (tag: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <input
      value={value}
      placeholder="nova tag + Enter"
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          const t = value.trim().replace(/^#/, '')
          if (t) {
            onAdd(t)
            setValue('')
          }
        }
      }}
    />
  )
}

/** Caixa de correção compartilhada por diagram e confirm. */
export function RefineBox({
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
