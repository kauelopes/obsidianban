import { useMemo, useState } from 'react'
import type { Card, CardSummary, Priority, Sprint } from '@obsidiankan/types'

const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical']

export interface FrontmatterDraft {
  title: string
  priority: Priority
  tags: string[]
  due_date: string | null
  assigned_to: string | null
  sprint_id: string | undefined
  blocked_by: string[]
}

export function draftFromCard(card: Card): FrontmatterDraft {
  return {
    title: card.title,
    priority: card.priority,
    tags: [...card.tags],
    due_date: card.due_date,
    assigned_to: card.assigned_to,
    sprint_id: card.sprint_id ?? undefined,
    blocked_by: [...card.blocked_by],
  }
}

/** Only the fields the user actually changed reach the server. */
export function changedFields(card: Card, draft: FrontmatterDraft): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (draft.title !== card.title) out['title'] = draft.title
  if (draft.priority !== card.priority) out['priority'] = draft.priority
  if (JSON.stringify(draft.tags) !== JSON.stringify(card.tags)) out['tags'] = draft.tags
  if (draft.due_date !== card.due_date) out['due_date'] = draft.due_date
  if (draft.assigned_to !== card.assigned_to) out['assigned_to'] = draft.assigned_to
  if ((draft.sprint_id ?? null) !== card.sprint_id && draft.sprint_id) {
    out['sprint_id'] = draft.sprint_id
  }
  if (JSON.stringify([...draft.blocked_by].sort()) !== JSON.stringify([...card.blocked_by].sort())) {
    out['blocked_by'] = draft.blocked_by
  }
  return out
}

export function FrontmatterForm({
  card,
  draft,
  onChange,
  sprints,
  candidates,
  disabled,
}: {
  card: Card
  draft: FrontmatterDraft
  onChange: (d: FrontmatterDraft) => void
  sprints: readonly Sprint[]
  /** Other cards in the same project — the autocomplete pool for blocked_by. */
  candidates: readonly CardSummary[]
  disabled: boolean
}) {
  const set = <K extends keyof FrontmatterDraft>(k: K, v: FrontmatterDraft[K]) =>
    onChange({ ...draft, [k]: v })

  return (
    <div className="form">
      <label>
        <span>Título</span>
        <input
          value={draft.title}
          maxLength={200}
          disabled={disabled}
          onChange={(e) => set('title', e.target.value)}
        />
      </label>

      <div className="form-row">
        <label>
          <span>Prioridade</span>
          <select
            value={draft.priority}
            disabled={disabled}
            onChange={(e) => set('priority', e.target.value as Priority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Due date</span>
          <input
            type="date"
            value={draft.due_date ?? ''}
            disabled={disabled}
            onChange={(e) => set('due_date', e.target.value || null)}
          />
        </label>

        <label>
          <span>Assignee</span>
          <input
            value={draft.assigned_to ?? ''}
            placeholder="agent:dev-1"
            disabled={disabled}
            onChange={(e) => set('assigned_to', e.target.value || null)}
          />
        </label>
      </div>

      <label>
        <span>Sprint</span>
        <select
          value={draft.sprint_id ?? ''}
          disabled={disabled}
          onChange={(e) => set('sprint_id', e.target.value || undefined)}
        >
          {sprints.length === 0 && <option value="">(nenhuma sprint)</option>}
          {sprints.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} — {s.status}
            </option>
          ))}
        </select>
      </label>

      <TagsField
        tags={draft.tags}
        disabled={disabled}
        onChange={(t) => set('tags', t)}
      />

      <BlockedByField
        value={draft.blocked_by}
        selfId={card.id}
        candidates={candidates}
        disabled={disabled}
        onChange={(b) => set('blocked_by', b)}
      />

      <ManagedFields card={card} />
    </div>
  )
}

function TagsField({
  tags,
  onChange,
  disabled,
}: {
  tags: string[]
  onChange: (t: string[]) => void
  disabled: boolean
}) {
  const [input, setInput] = useState('')
  function add() {
    const t = input.trim().replace(/^#/, '')
    if (!t || tags.includes(t) || tags.length >= 20) return
    onChange([...tags, t])
    setInput('')
  }
  return (
    <label>
      <span>Tags</span>
      <div className="chips">
        {tags.map((t) => (
          <span className="chip" key={t}>
            #{t}
            {!disabled && (
              <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))}>
                ×
              </button>
            )}
          </span>
        ))}
        <input
          value={input}
          placeholder="nova tag + Enter"
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
      </div>
    </label>
  )
}

/**
 * The reason this form exists at all: editing blocked_by used to mean typing
 * card ids by hand into YAML. Here it is a search over the project's cards.
 */
function BlockedByField({
  value,
  selfId,
  candidates,
  onChange,
  disabled,
}: {
  value: string[]
  selfId: string
  candidates: readonly CardSummary[]
  onChange: (b: string[]) => void
  disabled: boolean
}) {
  const [query, setQuery] = useState('')
  const byId = useMemo(
    () => new Map(candidates.map((c) => [c.id, c] as const)),
    [candidates],
  )
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return []
    return candidates
      .filter((c) => c.id !== selfId && !value.includes(c.id))
      .filter((c) => c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q))
      .slice(0, 8)
  }, [query, candidates, selfId, value])

  return (
    <label>
      <span>Bloqueado por</span>
      <div className="chips">
        {value.map((id) => (
          <span className="chip blocked" key={id} title={id}>
            {byId.get(id)?.title ?? id}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((x) => x !== id))}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <input
        value={query}
        placeholder="buscar card por título ou id…"
        disabled={disabled}
        onChange={(e) => setQuery(e.target.value)}
      />
      {matches.length > 0 && (
        <ul className="autocomplete">
          {matches.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([...value, c.id])
                  setQuery('')
                }}
              >
                <strong>{c.title}</strong>
                <em>
                  {c.status.replace(/_/g, ' ')} · {c.id}
                </em>
              </button>
            </li>
          ))}
        </ul>
      )}
    </label>
  )
}

/**
 * Shown read-only rather than hidden: these are real properties of the card,
 * and hiding them makes the model harder to reason about, not simpler.
 */
function ManagedFields({ card }: { card: Card }) {
  const rows: Array<[string, string]> = [
    ['id', card.id],
    ['project', card.project],
    ['type', card.type],
    ['status', card.status],
    ['version', String(card.version)],
    ['position', String(card.position)],
    ['tokens', `${card.total_input_tokens} in / ${card.total_output_tokens} out`],
    ['created', `${card.created_at} · ${card.created_by}`],
    ['updated', `${card.updated_at} · ${card.updated_by}`],
  ]
  return (
    <details className="managed">
      <summary>Campos gerenciados pelo sistema</summary>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
