import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { type Card, parseSections } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Markdown } from '../markdown/Markdown.js'

/** Splits the Agent Log into entries so each timestamp can be anchored. */
function splitLogEntries(log: string): Array<{ ts: string | null; text: string }> {
  if (!log.trim()) return []
  const lines = log.split('\n')
  const out: Array<{ ts: string | null; text: string[] }> = []
  const TS = /^\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\*\*\s*$/

  for (const line of lines) {
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
  defaultOpen = true,
}: {
  title: string
  kind?: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`zone${kind ? ` ${kind}` : ''}`}>
      <header onClick={() => setOpen((o) => !o)}>
        <span>{open ? '▾' : '▸'}</span>
        <span>{title}</span>
      </header>
      {open && <div className="body">{children}</div>}
    </section>
  )
}

export function CardDetail({ client }: { client: KanbanClient }) {
  const { id = '' } = useParams()
  const [card, setCard] = useState<Card | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void client.getCard(id).then((res) => {
      if (!alive) return
      if (res.ok) {
        setCard(res.data)
        setError(null)
      } else {
        setError(errorText(res.error))
      }
    })
    return () => {
      alive = false
    }
  }, [client, id])

  if (error) return <div className="detail"><p className="banner">{error}</p></div>
  if (!card) return <div className="detail"><p className="empty">carregando…</p></div>

  // body is optional in the contract — only kanban_get_card populates it.
  const zones = parseSections(card.body ?? '')
  const log = splitLogEntries(zones.agentLog)

  return (
    <div className="detail">
      <p><Link to="/">← board</Link></p>
      <h1>{card.title}</h1>
      <div className="card-meta" style={{ marginBottom: 18 }}>
        <span className="pill">{card.project}</span>
        <span className="pill">{card.status.replace(/_/g, ' ')}</span>
        <span className={`pill ${card.priority}`}>{card.priority}</span>
        <span className="pill">v{card.version}</span>
        <span className="pill">{card.type}</span>
        {card.assigned_to && <span className="pill">{card.assigned_to}</span>}
        {card.due_date && <span className="pill">{card.due_date}</span>}
        {card.blocked_by.map((b) => (
          <span className="pill blocked" key={b}>
            <Link to={`/card/${b}`}>{b}</Link>
          </span>
        ))}
        {card.tags.map((t) => (
          <span className="pill" key={t}>#{t}</span>
        ))}
      </div>

      <Zone title="Spec">
        <Markdown>{zones.spec}</Markdown>
      </Zone>

      <Zone title="Notes" kind="notes" defaultOpen={zones.notes.trim().length > 0}>
        <Markdown>{zones.notes}</Markdown>
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
        atualizado em {card.updated_at} por {card.updated_by}
      </p>
    </div>
  )
}
