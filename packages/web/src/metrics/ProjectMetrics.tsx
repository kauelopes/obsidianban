import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Metrics as MetricsData } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Tile } from './widgets.js'

/**
 * Estatísticas de UM projeto, dentro do workspace dele. Não é uma rota nova
 * no backend — `client.getMetrics` nunca aceitou filtro por projeto — e sim
 * um recorte client-side do breakdown `by_project` que a resposta vault-wide
 * já trazia (usado antes só como mais uma tabela/gráfico na Estatísticas
 * global). Por não ter os outros eixos (por ator, por modelo, fluxo, uso de
 * terminal) recortados por projeto, esta aba é propositalmente mais rasa —
 * link para a página global cobre quem precisa do detalhe completo.
 */
export function ProjectMetrics({ client, project }: { client: KanbanClient; project: string }) {
  const [data, setData] = useState<MetricsData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await client.getMetrics({})
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setError(null)
    setData(res.data)
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  if (!data && !error) {
    return <p className="empty-lg">carregando métricas…</p>
  }

  const row = data?.by_project.find((r) => r.project === project)

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Estatísticas</h1>
          <div className="detail-ident">
            <span className="mono">{project}</span>
          </div>
        </div>

        {error && <p className="banner">{error}</p>}

        {row ? (
          <>
            <div className="tiles" style={{ marginTop: 'var(--s-6)' }}>
              <Tile label="operações" value={row.ops.toLocaleString('pt-BR')} />
              <Tile
                label="tokens de entrada"
                value={row.input_tokens > 0 ? row.input_tokens.toLocaleString('pt-BR') : 'não reportado'}
                muted={row.input_tokens === 0}
              />
              <Tile
                label="tokens de saída"
                value={row.output_tokens > 0 ? row.output_tokens.toLocaleString('pt-BR') : 'não reportado'}
                muted={row.output_tokens === 0}
              />
            </div>
            <p className="note">
              Recorte deste projeto dentro do agregado do vault — sem filtro por ator/modelo/dia
              nem uso de terminal, que ainda não são separáveis por projeto.{' '}
              <Link to="/atividade">ver estatísticas completas do vault →</Link>
            </p>
          </>
        ) : (
          <p className="empty-lg">
            Nenhuma operação registrada para este projeto ainda.{' '}
            <Link to="/atividade">ver estatísticas completas do vault →</Link>
          </p>
        )}
      </div>
    </div>
  )
}
