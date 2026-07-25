import { useEffect, useState } from 'react'
import type { AuditEntry } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'

/**
 * Histórico do card, lido do audit log append-only.
 *
 * O dado estava no disco desde o primeiro dia e nenhuma UI o mostrava. Cada
 * mutação registra ator, versão e o que mudou.
 *
 * Os campos variam por call site, não só por `op`: há `UPDATE` com tokens e
 * `UPDATE` sem, e só `MOVE` traz from/to. Por isso tudo aqui é renderizado por
 * presença — nada é inferido a partir do `op`.
 */
export function CardHistory({ client, cardId }: { client: KanbanClient; cardId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null)
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const res = await client.getCardHistory({ id: cardId, limit: 100 })
      if (!alive) return
      if (!res.ok) {
        setError(errorText(res.error))
        setEntries([])
        return
      }
      setEntries(res.data.entries)
      setTruncated(res.data.truncated)
    })()
    return () => {
      alive = false
    }
  }, [client, cardId])

  if (error) return <p className="banner">{error}</p>
  if (entries === null) return <p className="empty">carregando histórico…</p>
  if (entries.length === 0) {
    return (
      <p className="empty">
        Nenhum registro. O audit log guarda mutações a partir do momento em que o servidor
        passou a rodar sobre este vault.
      </p>
    )
  }

  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>quando</th>
            <th>op</th>
            <th>ator</th>
            <th>o que mudou</th>
            <th className="num">v</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={`${e.ts}-${i}`}>
              <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                {e.ts}
              </td>
              <td>
                <span className={`history-op ${e.op}`}>{e.op}</span>
              </td>
              <td className="mono">{e.actor ?? '—'}</td>
              <td>{describe(e)}</td>
              <td className="num">{e.version ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {truncated && (
        <p className="empty">
          Mostrando as 100 entradas mais recentes; há mais no audit log.
        </p>
      )}
    </>
  )
}

/** Uma frase por registro, montada só com os campos que o registro tem. */
function describe(e: AuditEntry): string {
  const bits: string[] = []

  if (e.from_status || e.to_status) {
    bits.push(`${e.from_status ?? '?'} → ${e.to_status ?? '?'}`)
  }
  if (e.changed_fields && e.changed_fields.length > 0) {
    bits.push(e.changed_fields.join(', '))
  }
  if (e.reason) bits.push(e.reason)
  if (e.affected_cards && e.affected_cards.length > 0) {
    bits.push(`${e.affected_cards.length} cards reposicionados`)
  }
  if (e.field) bits.push(`campo ${e.field}`)

  // Tokens só aparecem quando alguém realmente reportou. Zero não é medição.
  const tokens = (e.input_tokens ?? 0) + (e.output_tokens ?? 0)
  if (tokens > 0) {
    bits.push(`${e.input_tokens ?? 0} in / ${e.output_tokens ?? 0} out${e.model ? ` (${e.model})` : ''}`)
  }

  return bits.length > 0 ? bits.join(' · ') : '—'
}
