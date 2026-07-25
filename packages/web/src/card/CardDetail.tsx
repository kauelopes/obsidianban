import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { type Card, type CardSummary, type Sprint, parseSections } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText, type McpResult } from '../api/result.js'
import { Markdown } from '../markdown/Markdown.js'
import {
  changedFields,
  draftFromCard,
  FrontmatterForm,
  type FrontmatterDraft,
} from './FrontmatterForm.js'
import { ConflictBar, type ConflictInfo, ZoneEditor } from './ZoneEditor.js'

/** Splits the Agent Log into entries so each timestamp can be anchored. */
export function splitLogEntries(log: string): Array<{ ts: string | null; text: string }> {
  if (!log.trim()) return []
  const out: Array<{ ts: string | null; text: string[] }> = []
  const TS = /^\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\*\*$/

  for (const line of log.split('\n')) {
    const m = TS.exec(line.trim())
    if (m) out.push({ ts: m[1]!, text: [] })
    else if (out.length === 0) out.push({ ts: null, text: [line] })
    else out[out.length - 1]!.text.push(line)
  }
  return out.map((e) => ({ ts: e.ts, text: e.text.join('\n').trim() }))
}

function Zone({
  title,
  kind,
  children,
  actions,
  defaultOpen = true,
}: {
  title: string
  kind?: string
  children: React.ReactNode
  actions?: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`zone${kind ? ` ${kind}` : ''}`}>
      <header>
        <span onClick={() => setOpen((o) => !o)} style={{ flex: 1 }}>
          {open ? '▾' : '▸'} {title}
        </span>
        {open && actions}
      </header>
      {open && <div className="body">{children}</div>}
    </section>
  )
}

export function CardDetail({
  client,
  sprintsFor,
  cardsFor,
}: {
  client: KanbanClient
  sprintsFor: (project: string) => readonly Sprint[]
  cardsFor: (project: string) => readonly CardSummary[]
}) {
  const { id = '' } = useParams()
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState<ConflictInfo | null>(null)

  const [editingMeta, setEditingMeta] = useState(false)
  const [editingSpec, setEditingSpec] = useState(false)
  const [editingNotes, setEditingNotes] = useState(false)

  const [draft, setDraft] = useState<FrontmatterDraft | null>(null)
  const [spec, setSpec] = useState('')
  const [notes, setNotes] = useState('')

  const load = useCallback(async () => {
    const res = await client.getCard(id)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    const c = res.data
    const zones = parseSections(c.body ?? '')
    setCard(c)
    setDraft(draftFromCard(c))
    setSpec(zones.spec)
    setNotes(zones.notes)
    setError(null)
  }, [client, id])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Every write funnels through here so conflict handling exists in exactly
   * one place. On 409 the local text is kept and the user decides.
   */
  const submit = useCallback(
    async (run: (c: Card) => Promise<McpResult<Card>>) => {
      if (!card) return false
      setSaving(true)
      const res = await run(card)
      setSaving(false)
      if (res.ok) {
        const c = res.data
        const zones = parseSections(c.body ?? '')
        setCard(c)
        setDraft(draftFromCard(c))
        setSpec(zones.spec)
        setNotes(zones.notes)
        setConflict(null)
        setError(null)
        return true
      }
      if (res.error.kind === 'conflict') {
        setConflict({
          yourVersion: res.error.yourVersion,
          currentVersion: res.error.currentVersion,
          conflictingFields: res.error.conflictingFields,
        })
        // Adopt the server's version so a retry lands on top of it, but keep
        // the user's unsaved text in the editors.
        if (res.error.currentCard) setCard(res.error.currentCard)
      } else {
        setError(errorText(res.error))
      }
      return false
    },
    [card],
  )

  const saveMeta = useCallback(async () => {
    if (!card || !draft) return
    const fields = changedFields(card, draft)
    if (Object.keys(fields).length === 0) {
      setEditingMeta(false)
      return
    }
    const ok = await submit((c) => client.updateCard({ id: c.id, version: c.version, ...fields }))
    if (ok) setEditingMeta(false)
  }, [card, draft, client, submit])

  const saveSpec = useCallback(async () => {
    const ok = await submit((c) => client.updateSpec({ id: c.id, version: c.version, spec }))
    if (ok) setEditingSpec(false)
  }, [client, spec, submit])

  const saveNotes = useCallback(async () => {
    const ok = await submit((c) => client.updateNotes({ id: c.id, version: c.version, notes }))
    if (ok) setEditingNotes(false)
  }, [client, notes, submit])

  if (error && !card) return <div className="detail"><p className="banner">{error}</p></div>
  if (!card || !draft) return <div className="detail"><p className="empty">carregando…</p></div>

  const zones = parseSections(card.body ?? '')
  const log = splitLogEntries(zones.agentLog)
  const dirty = editingSpec || editingNotes || editingMeta

  return (
    <div className="detail">
      <p><Link to="/">← board</Link></p>
      <h1>{card.title}</h1>

      {error && <p className="banner">{error}</p>}
      {conflict && (
        <ConflictBar
          conflict={conflict}
          onRetry={() => {
            setConflict(null)
            if (editingSpec) void saveSpec()
            else if (editingNotes) void saveNotes()
            else void saveMeta()
          }}
          onDiscard={() => {
            setConflict(null)
            setEditingSpec(false)
            setEditingNotes(false)
            setEditingMeta(false)
            void load()
          }}
        />
      )}

      <Zone
        title="Propriedades"
        actions={
          editingMeta ? (
            <>
              <button className="primary" disabled={saving} onClick={saveMeta}>salvar</button>
              <button disabled={saving} onClick={() => { setEditingMeta(false); setDraft(draftFromCard(card)) }}>
                cancelar
              </button>
            </>
          ) : (
            <button onClick={() => setEditingMeta(true)}>editar</button>
          )
        }
      >
        <FrontmatterForm
          card={card}
          draft={draft}
          onChange={setDraft}
          sprints={sprintsFor(card.project)}
          candidates={cardsFor(card.project)}
          disabled={!editingMeta || saving}
        />
      </Zone>

      <Zone
        title="Spec"
        actions={
          editingSpec ? (
            <>
              <button className="primary" disabled={saving} onClick={saveSpec}>salvar</button>
              <button disabled={saving} onClick={() => { setEditingSpec(false); setSpec(zones.spec) }}>
                cancelar
              </button>
            </>
          ) : (
            <button onClick={() => setEditingSpec(true)}>editar</button>
          )
        }
      >
        {editingSpec ? (
          <ZoneEditor
            value={spec}
            onChange={setSpec}
            disabled={saving}
            placeholder="Contexto, critérios de aceite, restrições."
          />
        ) : (
          <Markdown>{zones.spec}</Markdown>
        )}
      </Zone>

      <Zone
        title="Notes"
        kind="notes"
        defaultOpen={zones.notes.trim().length > 0}
        actions={
          editingNotes ? (
            <>
              <button className="primary" disabled={saving} onClick={saveNotes}>salvar</button>
              <button disabled={saving} onClick={() => { setEditingNotes(false); setNotes(zones.notes) }}>
                cancelar
              </button>
            </>
          ) : (
            <button onClick={() => setEditingNotes(true)}>editar</button>
          )
        }
      >
        {editingNotes ? (
          <ZoneEditor
            value={notes}
            onChange={setNotes}
            disabled={saving}
            rows={8}
            placeholder="Working memory do agente — substituível, não histórico."
          />
        ) : (
          <Markdown>{zones.notes}</Markdown>
        )}
      </Zone>

      <Zone title={`Agent Log (${log.length})`} kind="log" defaultOpen={false}>
        {log.length === 0 ? (
          <p className="empty">sem entradas</p>
        ) : (
          log.map((e, i) => (
            <div className="log-entry" key={`${e.ts ?? 'x'}-${i}`} id={e.ts ?? undefined}>
              {e.ts && <time dateTime={e.ts}>{e.ts}</time>}
              <Markdown>{e.text}</Markdown>
            </div>
          ))
        )}
      </Zone>

      <p className="empty">
        v{card.version} · atualizado em {card.updated_at} por {card.updated_by}
        {dirty && ' · alterações não salvas'}
      </p>
    </div>
  )
}
