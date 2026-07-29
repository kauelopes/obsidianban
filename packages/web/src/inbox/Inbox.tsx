import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { EscalationItem } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Markdown } from '../markdown/Markdown.js'

/**
 * Inbox de escalações — a tela que responde "onde os agentes precisam de mim".
 *
 * O §7 do PRD argumenta que o gargalo do humano não é gerenciar cards, é
 * supervisionar agentes autônomos. Antes disto, achar uma escalação exigia
 * abrir card por card e ler o Agent Log.
 *
 * A lista é todo card em `status: review` — a mesma regra que a triagem
 * automática do sprint workflow usa (ver docs/for-agents/sprint-workflow.md).
 * Por isso as ações espelham as saídas dessa triagem (CLOSE/RETURN): gravam
 * `pm_resolved` no log E tiram o card de `review`, porque só sair de `review`
 * remove o card da lista — logar sozinho não basta.
 */
export function Inbox({ client }: { client: KanbanClient }) {
  const [items, setItems] = useState<EscalationItem[] | null>(null)
  const [scanned, setScanned] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [reply, setReply] = useState('')

  const load = useCallback(async () => {
    const res = await client.listEscalations()
    if (!res.ok) {
      setError(errorText(res.error))
      setItems([])
      return
    }
    setError(null)
    setItems(res.data.escalations)
    setScanned(res.data.scanned)
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  /**
   * Mesmas duas saídas da triagem automática do sprint workflow (CLOSE/RETURN,
   * ver TRIAGE_SYSTEM em scripts/sprint-workflow.ts): grava a decisão no log
   * com `pm_resolved` e move o card para fora de `review` — porque é sair de
   * `review` que tira o card desta lista, não o log em si. FOLLOW-UP (criar um
   * card novo a partir da proposta do dev) não tem atalho aqui ainda; use
   * "Abrir card" e crie o card manualmente antes de resolver.
   */
  async function resolve(item: EscalationItem, text: string, outcome: 'close' | 'return') {
    setBusyId(item.card_id)
    setError(null)

    const logged = await client.logOnCard({
      id: item.card_id,
      version: item.version,
      log_entry: text,
      log_kind: 'pm_resolved',
    })
    if (!logged.ok) {
      setBusyId(null)
      setError(errorText(logged.error))
      return
    }

    const toStatus = outcome === 'close' ? 'done' : 'todo'
    if (logged.data.status !== toStatus) {
      // A versão vem da resposta anterior: o log já subiu a versão do card, e
      // reusar a antiga daria 409.
      const moved = await client.moveCard({
        id: item.card_id,
        version: logged.data.version,
        to_status: toStatus,
        input_tokens: 0,
        output_tokens: 0,
        model: 'human',
      })
      if (!moved.ok) {
        setBusyId(null)
        setError(errorText(moved.error))
        return
      }
    }

    setBusyId(null)
    setReplyTo(null)
    setReply('')
    void load()
  }

  if (items === null) {
    return (
      <div className="detail">
        <p className="empty-lg">carregando escalações…</p>
      </div>
    )
  }

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Escalações</h1>
          <div className="detail-ident">
            <span>
              {items.length} esperando decisão de {scanned} card{scanned === 1 ? '' : 's'}{' '}
              ativo{scanned === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {error && <p className="banner">{error}</p>}

        {items.length === 0 ? (
          <p className="empty-lg">
            Nada esperando você. Todo card em <code>review</code> aparece aqui — normalmente
            porque um dev agent está bloqueado ou quer propor uma mudança de escopo, e a
            triagem automática do sprint workflow não conseguiu resolver sozinha. Cards movidos
            manualmente para <code>review</code> no Obsidian também aparecem.
          </p>
        ) : (
          <ul className="inbox">
            {items.map((it) => (
              <li className="inbox-item" key={it.card_id}>
                <div className="inbox-head">
                  <Link className="inbox-title" to={`/card/${it.card_id}`}>
                    {it.title}
                  </Link>
                  <span className={`prio ${it.priority}`}>{it.priority}</span>
                  <div className="spacer" />
                  <span className="mono inbox-meta">
                    {it.project} · {it.status.replace(/_/g, ' ')} · {it.escalated_at ?? '—'}
                  </span>
                </div>

                <div className="inbox-reason">
                  <Markdown>{it.reason}</Markdown>
                </div>

                {replyTo === it.card_id ? (
                  <div className="editor">
                    <textarea
                      autoFocus
                      value={reply}
                      rows={4}
                      placeholder="Sua decisão. Vai para o Agent Log como pm_resolved."
                      onChange={(e) => setReply(e.target.value)}
                    />
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={busyId === it.card_id || !reply.trim()}
                        onClick={() => void resolve(it, reply.trim(), 'close')}
                        title="CLOSE — o trabalho está genuinamente concluído"
                      >
                        Concluir
                      </button>
                      <button
                        disabled={busyId === it.card_id || !reply.trim()}
                        onClick={() => void resolve(it, reply.trim(), 'return')}
                        title="RETURN — você resolveu o bloqueio, o dev agent pode continuar"
                      >
                        Devolver ao todo
                      </button>
                      <button
                        disabled={busyId === it.card_id}
                        onClick={() => {
                          setReplyTo(null)
                          setReply('')
                        }}
                      >
                        cancelar
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="inbox-actions">
                    <button
                      className="primary"
                      disabled={busyId !== null}
                      onClick={() => {
                        setReplyTo(it.card_id)
                        setReply('')
                      }}
                    >
                      Responder
                    </button>
                    <Link to={`/card/${it.card_id}`}>
                      <button disabled={busyId !== null}>Abrir card</button>
                    </Link>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
