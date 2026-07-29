import { useCallback, useEffect, useState } from 'react'
import { estimateUsd, type Metrics as MetricsData } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { BarChart, Tile, TokenTable } from './widgets.js'

/**
 * Painel de atividade e custo.
 *
 * Substitui a metrics-view do plugin, que mostrava 4 das 6 agregações em
 * tabelas planas e nenhum gráfico.
 *
 * Duas coisas conferidas contra o servidor moldaram esta tela:
 *
 * 1. As agregações NÃO são simétricas. `by_type` traz `ops`, `by_operation` traz
 *    `count`, e `by_day` e `by_agent` não trazem contagem nenhuma — só tokens.
 *    Então só `by_operation` e `by_type` podem virar gráfico de volume; os
 *    outros dois viram tabela.
 * 2. Tokens são zero em todo o histórico real, e por decisão: o prompt do dev
 *    agent manda omitir contagem de tokens. O único produtor de número
 *    verdadeiro é o sprint workflow, que passou a reportar a medição do harness.
 *    Até ele rodar, esta tela diz "não reportado" em vez de desenhar $0,00 e
 *    fingir que mediu.
 */
export function Metrics({ client }: { client: KanbanClient }) {
  const [data, setData] = useState<MetricsData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const load = useCallback(async () => {
    const res = await client.getMetrics({
      ...(from ? { from_date: from } : {}),
      ...(to ? { to_date: to } : {}),
    })
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setError(null)
    setData(res.data)
  }, [client, from, to])

  useEffect(() => {
    void load()
  }, [load])

  if (!data && !error) {
    return (
      <div className="detail">
        <p className="empty-lg">carregando métricas…</p>
      </div>
    )
  }

  const tokensReported = data ? data.summary.total_input_tokens + data.summary.total_output_tokens : 0

  /**
   * A estimativa só pode ser somada por MODELO — é o único eixo que carrega a
   * informação de preço. Se nenhum modelo da resposta estiver na tabela, o
   * resultado é null e nada é exibido, em vez de um zero que pareceria medição.
   */
  const estimated = (() => {
    if (!data) return null
    let sum = 0
    let any = false
    for (const row of data.by_model) {
      const usd = estimateUsd(row.model, row.input_tokens, row.output_tokens)
      if (usd === null) continue
      any = true
      sum += usd
    }
    return any && sum > 0 ? sum : null
  })()

  // Custo MEDIDO (cost_usd reportado pelas tools) — quando existe, é o número
  // autoritativo; a estimativa por tokens vira apenas complemento.
  // `?? 0` cobre servidor antigo (resposta sem os campos medidos).
  const measured =
    data && (data.summary.total_cost_usd ?? 0) > 0 ? data.summary.total_cost_usd : null
  const cacheTokens = data
    ? (data.summary.total_cache_read_tokens ?? 0) + (data.summary.total_cache_creation_tokens ?? 0)
    : 0

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Atividade</h1>
          <div className="detail-ident">
            <span>agregado do vault inteiro</span>
          </div>
        </div>

        {error && <p className="banner">{error}</p>}

        {/* Filtros numa linha só, acima dos gráficos. */}
        <div className="form-row filters" style={{ marginTop: 'var(--s-6)', alignItems: 'flex-end' }}>
          <label>
            <span>de</span>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            <span>até</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button
            onClick={() => {
              setFrom('')
              setTo('')
            }}
            disabled={!from && !to}
          >
            limpar
          </button>
        </div>

        {data && (
          <>
            <div className="tiles">
              <Tile label="operações" value={data.summary.total_ops.toLocaleString('pt-BR')} />
              <Tile
                label="tokens de entrada"
                value={
                  data.summary.total_input_tokens > 0
                    ? data.summary.total_input_tokens.toLocaleString('pt-BR')
                    : 'não reportado'
                }
                muted={data.summary.total_input_tokens === 0}
              />
              <Tile
                label="tokens de saída"
                value={
                  data.summary.total_output_tokens > 0
                    ? data.summary.total_output_tokens.toLocaleString('pt-BR')
                    : 'não reportado'
                }
                muted={data.summary.total_output_tokens === 0}
              />
              <Tile
                label="tokens de cache (r+w)"
                value={cacheTokens > 0 ? cacheTokens.toLocaleString('pt-BR') : 'não reportado'}
                muted={cacheTokens === 0}
              />
              <Tile
                label="custo medido (US$)"
                value={measured !== null ? measured.toFixed(4) : 'não reportado'}
                muted={measured === null}
              />
            </div>

            {measured !== null ? (
              <p className="note">
                Custo <strong>medido</strong>: soma do <code>cost_usd</code> reportado pelas
                próprias operações (o <code>total_cost_usd</code> do harness no sprint workflow).
                {estimated !== null && (
                  <> A estimativa por tokens ficaria em US$ {estimated.toFixed(4)} — ela ignora
                  cache e operações sem medição, use-a só como referência.</>
                )}
              </p>
            ) : (
              estimated !== null && (
                <p className="note">
                  Custo <strong>estimado</strong> em US$ {estimated.toFixed(4)} — calculado a partir
                  dos tokens por modelo e de uma tabela de preços local, não medido (nenhuma
                  operação reportou <code>cost_usd</code> ainda). Modelos fora da tabela
                  (<code>human</code>, <code>unknown</code>) não entram na conta.
                </p>
              )
            )}

            <BarChart
              title="Operações por tipo de mutação"
              rows={data.by_operation.map((r) => ({ label: r.op, value: r.count }))}
            />

            <BarChart
              title="Operações por tipo de card"
              rows={data.by_type.map((r) => ({ label: r.type, value: r.ops }))}
            />

            <BarChart
              title="Operações por projeto"
              rows={data.by_project.map((r) => ({ label: r.project, value: r.ops }))}
            />

            {/* by_agent não tem contagem, só tokens — por isso tabela e não gráfico. */}
            <TokenTable
              title="Por ator"
              head="ator"
              rows={data.by_agent.map((r) => ({
                label: r.actor,
                input: r.input_tokens,
                output: r.output_tokens,
              }))}
            />

            <TokenTable
              title="Por modelo"
              head="modelo"
              rows={data.by_model.map((r) => ({
                label: r.model,
                input: r.input_tokens,
                output: r.output_tokens,
              }))}
            />

            <TokenTable
              title="Por dia"
              head="data"
              rows={data.by_day.map((r) => ({
                label: r.date,
                input: r.input_tokens,
                output: r.output_tokens,
              }))}
            />

            {/* Rodapé, não manchete: a explicação é honesta mas não pode ser a
                primeira coisa da página — parecia aviso de sistema quebrado. */}
            {tokensReported === 0 && (
              <p className="note">
                Nenhum token foi reportado neste intervalo. Os agentes de dev são instruídos a
                não inventar contagem de tokens, então quem reporta medição real é o sprint
                workflow. O histórico também zera se o <code>db.sqlite</code> for apagado: a
                tabela <code>token_log</code> não é reconstruída a partir dos arquivos do vault.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}

