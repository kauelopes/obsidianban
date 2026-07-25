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
 * Cada item traz o texto da escalação, que é a pergunta de verdade, e as ações
 * respondem gravando um `pm_resolved` no log — o que tira o card da lista pela
 * mesma regra que o colocou nela.
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
   * Resolver = gravar a decisão no log com `pm_resolved`, e opcionalmente
   * devolver o card para `todo` para o dev agent poder pegá-lo de novo.
   */
  async function resolve(item: EscalationItem, text: string, backToTodo: boolean) {
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

    if (backToTodo && logged.data.status !== 'todo') {
      // A versão vem da resposta anterior: o log já subiu a versão do card, e
      // reusar a antiga daria 409.
      const moved = await client.moveCard({
        id: item.card_id,
        version: logged.data.version,
        to_status: 'todo',
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
      <div className="detail-inner">
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
            Nada esperando você. Um agente escala quando registra uma entrada com{' '}
            <code>log_kind: escalate</code> — normalmente porque está bloqueado ou quer propor
            uma mudança de escopo. Escalações escritas à mão no Obsidian, com o marcador{' '}
            <code>[ESCALATE]</code>, também aparecem aqui.
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
                        onClick={() => void resolve(it, reply.trim(), false)}
                      >
                        Registrar decisão
                      </button>
                      <button
                        disabled={busyId === it.card_id || !reply.trim()}
                        onClick={() => void resolve(it, reply.trim(), true)}
                      >
                        Registrar e devolver ao todo
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
