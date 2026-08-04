import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  estimateUsd,
  providerOf,
  type FlowMetrics,
  type Metrics as MetricsData,
  type ModelProvider,
} from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { BarChart, Tile, TokenTable } from './widgets.js'
import { FlowPanel } from './FlowPanel.js'

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  other: 'outros',
}

const ROLE_LABEL: Record<string, string> = {
  wizard: 'Wizard (planejamento)',
  pm: 'PM',
  dev: 'Dev',
  human: 'humano (via UI)',
  system: 'sistema',
  desconhecido: 'desconhecido (anterior ao rastreio por agente)',
}

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
  // Fluxo é uma segunda fonte (audit log) sob o mesmo filtro de datas. Falha
  // dele não pode esconder o custo, que é a metade que já funcionava.
  const [flow, setFlow] = useState<FlowMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const load = useCallback(async () => {
    const range = {
      ...(from ? { from_date: from } : {}),
      ...(to ? { to_date: to } : {}),
    }
    const [res, flowRes] = await Promise.all([client.getMetrics(range), client.getFlow(range)])
    setFlow(flowRes.ok ? flowRes.data : null)
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
      const usd = estimateUsd(row.model, row.input_tokens, row.output_tokens, {
        readTokens: row.cache_read_tokens,
        creationTokens: row.cache_creation_tokens,
      })
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
          <h1>Estatísticas</h1>
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
                label="custo medido (US$, lista API)"
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
                )}{' '}
                Em ambos os casos o valor é o <strong>preço de lista da API</strong> (pay-per-token):
                não reflete o que você paga num plano de assinatura como Claude Max, que é flat-rate.
                Use os totais de tokens acima se quiser uma medida sem essa distorção.
              </p>
            ) : (
              estimated !== null && (
                <p className="note">
                  Custo <strong>estimado</strong> em US$ {estimated.toFixed(4)} — calculado a partir
                  dos tokens por modelo e de uma tabela de preços local, não medido (nenhuma
                  operação reportou <code>cost_usd</code> ainda). Modelos fora da tabela
                  (<code>human</code>, <code>unknown</code>) não entram na conta. É{' '}
                  <strong>preço de lista da API</strong>: não reflete um plano de assinatura
                  flat-rate como Claude Max. Use os totais de tokens acima se quiser uma medida
                  sem essa distorção.
                </p>
              )
            )}

            {flow && <FlowPanel data={flow} />}

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
              showCost
              rows={data.by_agent.map((r) => ({
                label: r.actor,
                input: r.input_tokens,
                output: r.output_tokens,
                cost: r.cost_usd,
              }))}
            />

            {/* Único eixo com cache_read/creation_tokens — os outros nunca carregam esse dado. */}
            <TokenTable
              title="Por modelo"
              head="modelo"
              showCache
              showCost
              rows={data.by_model.map((r) => ({
                label: r.model,
                input: r.input_tokens,
                output: r.output_tokens,
                cacheRead: r.cache_read_tokens,
                cacheCreation: r.cache_creation_tokens,
                cost: r.cost_usd,
              }))}
            />

            <TokenTable
              title="Por dia"
              head="data"
              showCost
              rows={data.by_day.map((r) => ({
                label: r.date,
                input: r.input_tokens,
                output: r.output_tokens,
                cost: r.cost_usd,
              }))}
            />

            <Usage metrics={data} />

            {data.terminal && <TerminalUsage terminal={data.terminal} byOrigin={data.by_origin} />}

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

/**
 * Uso do TERMINAL — sessões de Claude Code fora do board, ingeridas dos
 * `.jsonl` locais em `~/.claude/projects`. `cost_usd` aqui é SEMPRE estimado
 * (nunca medido pelo harness, diferente de `by_role`/`by_agent` acima) — por
 * isso a seção fica separada e rotulada, nunca somada ao "custo medido".
 */
function TerminalUsage({
  terminal,
  byOrigin,
}: {
  terminal: NonNullable<MetricsData['terminal']>
  byOrigin: MetricsData['by_origin']
}) {
  const cacheTokens = terminal.total_cache_read_tokens + terminal.total_cache_creation_tokens
  return (
    <section className="chart">
      <p className="label">Terminal (sessões Claude Code fora do board)</p>
      <div className="tiles">
        <Tile label="operações (terminal)" value={terminal.total_ops.toLocaleString('pt-BR')} />
        <Tile
          label="tokens de cache (r+w)"
          value={cacheTokens > 0 ? cacheTokens.toLocaleString('pt-BR') : 'sem dados'}
          muted={cacheTokens === 0}
        />
        <Tile
          label="custo estimado (terminal, US$)"
          value={terminal.total_cost_usd > 0 ? terminal.total_cost_usd.toFixed(2) : 'sem dados'}
          muted={terminal.total_cost_usd === 0}
        />
      </div>
      {terminal.total_ops === 0 ? (
        <p className="empty">
          Nenhuma sessão de terminal encontrada em <code>~/.claude/projects</code> neste intervalo.
        </p>
      ) : (
        <>
          {byOrigin && (
            <BarChart
              title="Custo por origem (US$, board medido + terminal estimado)"
              rows={byOrigin.map((r) => ({
                label: r.origin === 'board' ? 'board' : 'terminal',
                value: Number(r.cost_usd.toFixed(4)),
              }))}
            />
          )}
          <p className="note">
            Custo do terminal é sempre <strong>estimado</strong> por tabela local de preços —
            inclui cache read/write (≈69% do custo real em sessões interativas), mas nunca é uma
            medição do harness. Ingestão incremental dos `.jsonl` locais; sessões com{' '}
            <code>cwd</code> fora dos <code>target_repo</code> conhecidos não são atribuídas a
            nenhum projeto.
          </p>
        </>
      )}
    </section>
  )
}

/**
 * Uso agregado por provedor, por tipo de agente e por projeto. O custo do
 * bloco "por provedor" é ESTIMADO por tabela local de preços de lista da API
 * (pay-per-token) — modelos fora dela (human, unknown…) não entram na conta.
 * Não reflete plano de assinatura flat-rate (Claude Max etc.).
 */
function Usage({ metrics }: { metrics: MetricsData }) {
  const providers = useMemo(() => {
    const acc = new Map<ModelProvider, { input: number; output: number; usd: number; models: string[] }>()
    for (const row of metrics.by_model) {
      const prov = providerOf(row.model)
      const cur = acc.get(prov) ?? { input: 0, output: 0, usd: 0, models: [] }
      cur.input += row.input_tokens
      cur.output += row.output_tokens
      cur.usd +=
        estimateUsd(row.model, row.input_tokens, row.output_tokens, {
          readTokens: row.cache_read_tokens,
          creationTokens: row.cache_creation_tokens,
        }) ?? 0
      cur.models.push(row.model)
      acc.set(prov, cur)
    }
    return acc
  }, [metrics])

  const reported = metrics.summary.total_input_tokens + metrics.summary.total_output_tokens

  return (
    <div className="home-usage">
      <section className="chart">
        <p className="label">uso por provedor</p>
        {reported === 0 ? (
          <p className="empty">nenhum token reportado no período selecionado</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>provedor</th>
                <th className="num">entrada</th>
                <th className="num">saída</th>
                <th
                  className="num"
                  title="Preço de lista da API pay-per-token — não é o que você paga num plano de assinatura (Claude Max etc.)"
                >
                  custo estimado ≈ (lista API)
                </th>
              </tr>
            </thead>
            <tbody>
              {(['anthropic', 'openai', 'other'] as const)
                .filter((prov) => providers.has(prov))
                .map((prov) => {
                  const v = providers.get(prov)!
                  return (
                    <tr key={prov} title={v.models.join(', ')}>
                      <td>{PROVIDER_LABEL[prov]}</td>
                      <td className="num">{v.input > 0 ? v.input.toLocaleString('pt-BR') : '—'}</td>
                      <td className="num">{v.output > 0 ? v.output.toLocaleString('pt-BR') : '—'}</td>
                      <td className="num">{v.usd > 0 ? `US$ ${v.usd.toFixed(4)}` : '—'}</td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        )}
      </section>

      {metrics.by_role.length > 0 && (
        <section className="chart">
          <p className="label">gasto por agente</p>
          <table className="table">
            <thead>
              <tr>
                <th>agente</th>
                <th className="num">ops</th>
                <th className="num">entrada</th>
                <th className="num">saída</th>
                <th
                  className="num"
                  title="Custo MEDIDO reportado pelo harness — 0 em linhas antigas sem essa medição, não necessariamente custo zero"
                >
                  custo medido
                </th>
              </tr>
            </thead>
            <tbody>
              {metrics.by_role.map((r) => (
                <tr key={r.role} className={r.role === 'desconhecido' ? 'muted' : undefined}>
                  <td>{ROLE_LABEL[r.role] ?? r.role}</td>
                  <td className="num">{r.ops.toLocaleString('pt-BR')}</td>
                  <td className="num">
                    {r.input_tokens > 0 ? r.input_tokens.toLocaleString('pt-BR') : '—'}
                  </td>
                  <td className="num">
                    {r.output_tokens > 0 ? r.output_tokens.toLocaleString('pt-BR') : '—'}
                  </td>
                  <td className="num">{r.cost_usd > 0 ? `US$ ${r.cost_usd.toFixed(4)}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {metrics.by_project.length > 0 && (
        <section className="chart">
          <p className="label">operações por projeto</p>
          <table className="table">
            <thead>
              <tr>
                <th>projeto</th>
                <th className="num">ops</th>
                <th className="num">entrada</th>
                <th className="num">saída</th>
              </tr>
            </thead>
            <tbody>
              {metrics.by_project.map((r) => (
                <tr key={r.project}>
                  <td className="mono">{r.project}</td>
                  <td className="num">{r.ops.toLocaleString('pt-BR')}</td>
                  <td className="num">
                    {r.input_tokens > 0 ? r.input_tokens.toLocaleString('pt-BR') : '—'}
                  </td>
                  <td className="num">
                    {r.output_tokens > 0 ? r.output_tokens.toLocaleString('pt-BR') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  )
}

