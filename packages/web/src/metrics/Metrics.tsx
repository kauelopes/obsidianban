import { useCallback, useEffect, useState } from 'react'
import { estimateUsd, type Metrics as MetricsData } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'

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

  return (
    <div className="detail">
      <div className="detail-inner">
        <div className="detail-head">
          <h1>Atividade</h1>
          <div className="detail-ident">
            <span>agregado do vault inteiro · /metrics não separa por projeto</span>
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
            </div>

            {estimated !== null && (
              <p className="note">
                Custo <strong>estimado</strong> em US$ {estimated.toFixed(4)} — calculado a partir
                dos tokens por modelo e de uma tabela de preços local, não medido. O número
                autoritativo é o <code>total_cost_usd</code> que o harness reporta ao sprint
                workflow. Modelos fora da tabela (<code>human</code>, <code>unknown</code>) não
                entram na conta.
              </p>
            )}

            {tokensReported === 0 && (
              <p className="note">
                Nenhum token foi reportado neste intervalo. Os agentes de dev são instruídos a
                não inventar contagem de tokens, então quem reporta medição real é o sprint
                workflow. O histórico também zera se o <code>db.sqlite</code> for apagado: a
                tabela <code>token_log</code> não é reconstruída a partir dos arquivos do vault.
              </p>
            )}

            <BarChart
              title="Operações por tipo de mutação"
              rows={data.by_operation.map((r) => ({ label: r.op, value: r.count }))}
            />

            <BarChart
              title="Operações por tipo de card"
              rows={data.by_type.map((r) => ({ label: r.type, value: r.ops }))}
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
          </>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <strong className={muted ? 'tile-value muted' : 'tile-value'}>{value}</strong>
    </div>
  )
}

/**
 * Barras horizontais, série única.
 *
 * Uma cor só, não uma rampa: o validador do dataviz reprovou a rampa
 * sequencial deste teal — os passos escuros caem abaixo de 3:1 contra a
 * superfície. Série única também dispensa legenda, e cada barra leva o valor
 * escrito, que é o "relief" exigido e torna o gráfico legível sem depender de
 * cor. `<title>` dá tooltip por marca sem uma linha de JS.
 */
function BarChart({
  title,
  rows,
}: {
  title: string
  rows: Array<{ label: string; value: number }>
}) {
  if (rows.length === 0) {
    return (
      <section className="chart">
        <p className="label">{title}</p>
        <p className="empty">sem dados neste intervalo</p>
      </section>
    )
  }

  const max = Math.max(...rows.map((r) => r.value), 1)
  const total = rows.reduce((n, r) => n + r.value, 0)

  return (
    <section className="chart">
      <p className="label">{title}</p>
      <ul className="bars">
        {rows.map((r) => {
          const pct = (r.value / max) * 100
          const share = total > 0 ? Math.round((r.value / total) * 100) : 0
          return (
            <li key={r.label} title={`${r.label}: ${r.value} (${share}% do total)`}>
              <span className="bar-label mono">{r.label}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="bar-value mono">{r.value.toLocaleString('pt-BR')}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function TokenTable({
  title,
  head,
  rows,
}: {
  title: string
  head: string
  rows: Array<{ label: string; input: number; output: number }>
}) {
  return (
    <section className="chart">
      <p className="label">{title}</p>
      {rows.length === 0 ? (
        <p className="empty">sem dados neste intervalo</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{head}</th>
              <th className="num">entrada</th>
              <th className="num">saída</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="mono">{r.label}</td>
                <td className="num">{r.input > 0 ? r.input.toLocaleString('pt-BR') : '—'}</td>
                <td className="num">{r.output > 0 ? r.output.toLocaleString('pt-BR') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
