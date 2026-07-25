import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Card } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'

/**
 * Arquivar, desarquivar, deletar e liberar claim.
 *
 * Os três primeiros já existiam no cliente desde a fase 2 sem um único call
 * site — dava para fazer pelo curl e não pela tela. O quarto é de supervisão:
 * um agente que morreu no meio do trabalho deixa `assigned_to` preso para
 * sempre, e sem isto a única saída era editar o .md na mão.
 */
export function CardActions({
  client,
  card,
  onDone,
}: {
  client: KanbanClient
  card: Card
  onDone: () => void
}) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  async function run(fn: () => Promise<{ ok: boolean; error?: unknown }>) {
    setBusy(true)
    setError(null)
    const res = (await fn()) as Awaited<ReturnType<typeof client.archiveCard>>
    setBusy(false)
    if (res.ok) onDone()
    else setError(errorText(res.error))
  }

  return (
    <section className="card-actions">
      {error && <p className="banner">{error}</p>}
      <div className="row">
        <span className="label">Ações</span>

        {card.archived ? (
          <button
            disabled={busy}
            onClick={() => run(() => client.unarchiveCard({ id: card.id, version: card.version }))}
          >
            desarquivar
          </button>
        ) : (
          <button
            disabled={busy}
            onClick={() => run(() => client.archiveCard({ id: card.id, version: card.version }))}
          >
            arquivar
          </button>
        )}

        {/*
          Só faz sentido quando há claim. `revert_to_status: null` mantém a
          coluna atual — mover o card de volta para todo é decisão separada de
          soltar o claim.
        */}
        {card.assigned_to && (
          <button
            disabled={busy}
            title={`Liberar o claim de ${card.assigned_to} sem mudar a coluna`}
            onClick={() =>
              run(() =>
                client.releaseCard({
                  id: card.id,
                  version: card.version,
                  revert_to_status: null,
                }),
              )
            }
          >
            liberar claim de {card.assigned_to}
          </button>
        )}

        <div className="spacer" />

        {confirmDelete ? (
          <>
            <span className="label" style={{ color: 'var(--alert)' }}>
              deletar de vez?
            </span>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                const res = await client.deleteCard({ id: card.id, version: card.version })
                setBusy(false)
                if (res.ok) navigate('/')
                else setError(errorText(res.error))
              }}
            >
              sim, deletar
            </button>
            <button disabled={busy} onClick={() => setConfirmDelete(false)}>
              cancelar
            </button>
          </>
        ) : (
          <button className="danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
            deletar
          </button>
        )}
      </div>
    </section>
  )
}
