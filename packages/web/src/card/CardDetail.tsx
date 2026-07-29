import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  type Card,
  type CardSummary,
  type LogKind,
  type Sprint,
  parseLogEntries,
  parseSections,
} from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { subscribe } from '../api/events.js'
import { errorText, type McpResult } from '../api/result.js'
import { Markdown } from '../markdown/Markdown.js'
import { humanTime } from '../util/time.js'
import { authorOf } from './author.js'
import { CardActions } from './CardActions.js'
import { CardHistory } from './CardHistory.js'
import {
  changedFields,
  draftFromCard,
  FrontmatterForm,
  type FrontmatterDraft,
} from './FrontmatterForm.js'
import { ConflictBar, type ConflictInfo, ZoneEditor } from './ZoneEditor.js'

/**
 * A divisão do Agent Log em entradas mora em @obsidiankan/types: é parte do
 * contrato do formato, não desta tela. Havia uma segunda implementação aqui que
 * não conhecia `log_kind` — duas fontes de verdade para o mesmo parse.
 */

/** Glifo e rótulo por natureza de entrada. Nunca só cor. */
const KIND_MARK: Record<LogKind, { glyph: string; label: string }> = {
  progress: { glyph: '·', label: 'progresso' },
  escalate: { glyph: '▲', label: 'escalou' },
  done: { glyph: '●', label: 'concluiu' },
  pm_resolved: { glyph: '✓', label: 'resolvido' },
}

/**
 * Mesma regra da inbox: vale o kind da entrada mais recente que declarou um.
 * Um `progress` posterior não resolve uma escalação pendente.
 */
function lastKindOf(entries: ReadonlyArray<{ kind: LogKind; explicit: boolean }>): LogKind | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.explicit) return e.kind
  }
  return null
}

/**
 * Cada zona diz na própria borda quem pode escrever nela. O contrato de três
 * zonas do PRD deixa de viver só no documento.
 */
function Zone({
  title,
  who,
  kind,
  children,
  actions,
  defaultOpen = true,
}: {
  title: string
  who: string
  kind?: string
  children: React.ReactNode
  actions?: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`zone${kind ? ` ${kind}` : ''}${open ? '' : ' collapsed'}`}>
      <header>
        <button
          className="ghost chev"
          aria-expanded={open}
          aria-label={`${open ? 'Recolher' : 'Expandir'} ${title}`}
          onClick={() => setOpen((o) => !o)}
          style={{ padding: 0 }}
        >
          ▾
        </button>
        <h2 onClick={() => setOpen((o) => !o)} style={{ cursor: 'pointer' }}>
          {title}
        </h2>
        <span className="who">{who}</span>
        <div className="spacer" />
        {open && actions}
      </header>
      {open && <div className="zone-body">{children}</div>}
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
  const [stale, setStale] = useState(false)

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
    setStale(false)
  }, [client, id])

  useEffect(() => {
    void load()
  }, [load])

  const dirty = editingSpec || editingNotes || editingMeta
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty

  /**
   * O detail não assinava SSE: um agente escrevendo no card enquanto a tela
   * estava aberta deixava a tela mentindo até um reload manual.
   *
   * Com edição em curso não recarregamos — isso apagaria o texto não salvo.
   * Marcamos como desatualizado e deixamos a decisão para quem está editando.
   */
  useEffect(() => {
    if (!id) return
    return subscribe((ev) => {
      if (ev.payload['card_id'] !== id) return
      if (
        ev.type !== 'CARD_UPDATED' &&
        ev.type !== 'CARD_MOVED' &&
        ev.type !== 'CARD_HUMAN_EDITED' &&
        ev.type !== 'CARD_ARCHIVED' &&
        ev.type !== 'CARD_UNARCHIVED'
      ) {
        return
      }
      if (dirtyRef.current) setStale(true)
      else void load()
    })
  }, [id, load])

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
        setStale(false)
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

  if (error && !card) {
    return (
      <div className="detail">
        <div className="detail-inner">
          <p className="banner">{error}</p>
          <p>
            <Link to="/">← board</Link>
          </p>
        </div>
      </div>
    )
  }
  if (!card || !draft) {
    return (
      <div className="detail">
        <p className="empty-lg">carregando o card…</p>
      </div>
    )
  }

  const zones = parseSections(card.body ?? '')
  const log = parseLogEntries(zones.agentLog)
  const pending = log.length > 0 && lastKindOf(log) === 'escalate'
  const author = authorOf(card.updated_by)

  return (
    <div className="detail">
      <div className="detail-inner">
        <div className="detail-head">
          <Link className="back" to={`/board/${card.project}`}>
            ← board
          </Link>
          <h1>{card.title}</h1>
          <div className="detail-ident">
            <span>{card.id}</span>
            <span className="sep">│</span>
            <span>{card.project}</span>
            <span className="sep">│</span>
            <span>{card.status.replace(/_/g, ' ')}</span>
            <span className="sep">│</span>
            <span>{card.type}</span>
            <span className="sep">│</span>
            <span>v{card.version}</span>
            <span className="sep">│</span>
            <span title={`atualizado por ${card.updated_by}`}>
              {author === 'human' ? 'humano' : author === 'agent' ? 'agente' : card.updated_by}
            </span>
            <span className="sep">│</span>
            <span title={card.updated_at}>{humanTime(card.updated_at)}</span>
          </div>
        </div>

        {error && <p className="banner">{error}</p>}

        {stale && (
          <p className="banner">
            Este card mudou no servidor enquanto você editava. Suas alterações não foram
            descartadas.
            <button className="ghost" onClick={() => void load()}>
              recarregar e perder edições
            </button>
          </p>
        )}

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
          who="humano e pm"
          actions={
            editingMeta ? (
              <>
                <button className="primary" disabled={saving} onClick={saveMeta}>
                  salvar
                </button>
                <button
                  disabled={saving}
                  onClick={() => {
                    setEditingMeta(false)
                    setDraft(draftFromCard(card))
                  }}
                >
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
            editing={editingMeta}
            disabled={saving}
          />
        </Zone>

        <Zone
          title="Spec"
          kind="spec"
          who="humano e pm escrevem · dev só lê"
          actions={
            editingSpec ? (
              <>
                <button className="primary" disabled={saving} onClick={saveSpec}>
                  salvar
                </button>
                <button
                  disabled={saving}
                  onClick={() => {
                    setEditingSpec(false)
                    setSpec(zones.spec)
                  }}
                >
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
            <Markdown prose>{zones.spec}</Markdown>
          )}
        </Zone>

        <Zone
          title="Notes"
          kind="notes"
          who="memória de trabalho do agente · substituível"
          defaultOpen={zones.notes.trim().length > 0}
          actions={
            editingNotes ? (
              <>
                <button className="primary" disabled={saving} onClick={saveNotes}>
                  salvar
                </button>
                <button
                  disabled={saving}
                  onClick={() => {
                    setEditingNotes(false)
                    setNotes(zones.notes)
                  }}
                >
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

        {/* Escalação pendente abre o log automaticamente: é o que você veio ver. */}
        <Zone
          title={`Agent Log (${log.length})`}
          kind={pending ? 'log pending' : 'log'}
          who={pending ? 'esperando sua decisão' : 'append-only · agentes escrevem'}
          defaultOpen={pending || (log.length > 0 && log.length <= 12)}
        >
          {log.length === 0 ? (
            <p className="empty">sem entradas</p>
          ) : (
            <ol className="tape">
              {log.map((e, i) => {
                const mark = KIND_MARK[e.kind]
                return (
                  <li
                    className={`tape-entry kind-${e.kind}${e.ts ? '' : ' loose'}`}
                    key={`${e.ts ?? 'x'}-${i}`}
                    id={e.ts ?? undefined}
                  >
                    <span className="tick" aria-hidden="true">
                      {mark.glyph}
                    </span>
                    <span className="tape-head">
                      {e.ts ? (
                        <time dateTime={e.ts} title={e.ts}>
                          {humanTime(e.ts)}
                        </time>
                      ) : (
                        <time>sem timestamp</time>
                      )}
                      {/*
                        O rótulo acompanha o glifo sempre: a natureza da entrada
                        nunca é dita só por cor ou só por forma.
                      */}
                      {e.explicit && <span className="kind-label">{mark.label}</span>}
                    </span>
                    <Markdown>{e.text}</Markdown>
                  </li>
                )
              })}
            </ol>
          )}
        </Zone>

        {/* Fechado por padrão: é auditoria, não leitura corrente. */}
        <Zone title="Histórico" who="audit log · append-only" defaultOpen={false}>
          <CardHistory client={client} cardId={card.id} />
        </Zone>

        <CardActions client={client} card={card} onDone={() => void load()} />

        {dirty && <p className="empty">alterações não salvas</p>}
      </div>
    </div>
  )
}
