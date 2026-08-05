import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  estimateUsd,
  providerOf,
  type FlowMetrics,
  type Metrics as MetricsData,
  type ModelProvider,
  type WeeklyDigest,
} from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { addDays, mondayOf, todayIso, fmtDay } from '../util/time.js'
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

const TABS = [
  { key: 'geral', label: 'Geral' },
  { key: 'board', label: 'Uso via board' },
  { key: 'terminal', label: 'Uso terminal' },
  { key: 'revisao', label: 'Revisão' },
] as const

type TabKey = (typeof TABS)[number]['key']

/**
 * Painel de atividade e custo.
 *
 * Menu lateral em vez de pilha vertical única — a página tinha crescido pra
 * ~13 seções empilhadas sem hierarquia (tiles, 3 gráficos, 3 tabelas, uso por
 * provedor/agente, uso de terminal, revisão semanal). Cada aba é uma pergunta
 * diferente ("quanto gastei", "quem gastou via board", "e via terminal",
 * "o que fechou essa semana"), então vira aba em vez de seção.
 *
 * Duas coisas conferidas contra o servidor moldaram o conteúdo de cada aba:
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
  const [activeTab, setActiveTab] = useState<TabKey>('geral')

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

        <div className="settings-layout" style={{ marginTop: 'var(--s-6)' }}>
          <nav className="settings-nav" aria-label="Seções de estatísticas">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={activeTab === t.key ? 'active' : undefined}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          <div className="settings-content">
            {activeTab !== 'revisao' && (
              <div className="form-row filters" style={{ alignItems: 'flex-end', marginBottom: 'var(--s-6)' }}>
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
            )}

            {activeTab === 'geral' && data && (
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

            {activeTab === 'board' && data && (
              <>
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
              </>
            )}

            {activeTab === 'terminal' && data && (
              <>
                {data.terminal ? (
                  <TerminalUsage terminal={data.terminal} byOrigin={data.by_origin} />
                ) : (
                  <p className="empty-lg">Sem dados de terminal para o intervalo selecionado.</p>
                )}
              </>
            )}

            {activeTab === 'revisao' && <ReviewTab client={client} />}
          </div>
        </div>
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

// timeZone UTC: o instante é montado com Date.UTC, e formatar em fuso local
// jogaria o dia para trás a oeste de Greenwich.
const rangeFmt = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})

/**
 * Retrospectiva da semana: o que fechou, o que vem, o que travou. Vive aqui
 * (aba de Estatísticas) em vez de rota própria — é mais uma pergunta sobre
 * atividade do vault, com sua própria navegação por semana em vez do filtro
 * de data das outras abas.
 *
 * Computado, não escrito por agente — o valor aqui é ser um espelho fiel e
 * barato do vault, e prosa gerada custaria uma chamada de LLM por navegação
 * de semana para dizer o que a lista já diz.
 */
export function ReviewTab({ client }: { client: KanbanClient }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayIso()))
  const [data, setData] = useState<WeeklyDigest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await client.getDigest({ week_start: weekStart })
    setLoading(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setError(null)
    setData(res.data)
  }, [client, weekStart])

  useEffect(() => {
    void load()
  }, [load])

  const thisWeek = mondayOf(todayIso())
  const isCurrent = weekStart >= thisWeek

  return (
    <div>
      <div className="detail-ident mono" style={{ marginBottom: 'var(--s-4)' }}>
        {rangeLabel(weekStart)}
      </div>

      {error && <p className="banner">{error}</p>}

      <div className="horizon-nav">
        <button
          className="ghost"
          aria-label="Semana anterior"
          onClick={() => setWeekStart((w) => addDays(w, -7))}
        >
          ‹ semana anterior
        </button>
        {!isCurrent && (
          <button className="ghost" onClick={() => setWeekStart(thisWeek)}>
            esta semana
          </button>
        )}
        <button
          className="ghost"
          aria-label="Próxima semana"
          disabled={isCurrent}
          onClick={() => setWeekStart((w) => addDays(w, 7))}
        >
          próxima semana ›
        </button>
      </div>

      {loading && !data ? (
        <p className="empty-lg">carregando a semana…</p>
      ) : data ? (
        <>
          <div className="tiles">
            <Tile label="sprints fechadas" value={String(data.sprints_closed.length)} />
            <Tile label="cards concluídos" value={String(data.cards_done.length)} />
            <Tile label="metas concluídas" value={String(data.goals_done.length)} />
            <Tile
              label="horas estimadas"
              value={data.hours_estimate_available ? `≈ ${data.hours_estimate.toLocaleString('pt-BR')} h` : '—'}
              muted={!data.hours_estimate_available}
            />
            <Tile
              label="custo medido"
              value={
                data.activity.summary.total_cost_usd > 0
                  ? `US$ ${data.activity.summary.total_cost_usd.toFixed(2)}`
                  : 'não reportado'
              }
              muted={data.activity.summary.total_cost_usd === 0}
            />
          </div>

          <ReviewSection title="Sprints fechadas" empty="Nenhuma sprint fechou nesta semana.">
            {data.sprints_closed.map((s) => (
              <li key={`${s.project}/${s.sprint_id}`}>
                <Link to={`/board/${s.project}`}>
                  <strong>{s.name}</strong>
                  <span className="where mono">{s.project}</span>
                </Link>
                {s.goal && <p className="review-note">{s.goal}</p>}
              </li>
            ))}
          </ReviewSection>

          <ReviewSection title="Cards concluídos" empty="Nenhum card entrou em done nesta semana.">
            {data.cards_done.map((c) => (
              <li key={`${c.card_id}/${c.ts}`}>
                <Link to={`/card/${c.card_id}`}>
                  <strong>{c.title}</strong>
                  <span className="where mono">{c.project}</span>
                </Link>
              </li>
            ))}
          </ReviewSection>

          <ReviewSection title="Metas concluídas" empty="Nenhuma meta foi concluída nesta semana.">
            {data.goals_done.map((g) => (
              <li key={`${g.project}/${g.goal_id}`}>
                <Link to={`/board/${g.project}`}>
                  <strong>{g.title}</strong>
                  <span className="where mono">{g.project}</span>
                </Link>
              </li>
            ))}
          </ReviewSection>

          <ReviewSection title="Metas da semana que vem" empty="Nenhuma meta vence na semana seguinte.">
            {data.goals_upcoming.map((g) => (
              <li key={`${g.project}/${g.goal_id}`}>
                <Link to="/horizonte">
                  <strong>{g.title}</strong>
                  <span className="where mono">{g.project}</span>
                  <span className="age mono">{fmtDay(g.target_date)}</span>
                </Link>
              </li>
            ))}
          </ReviewSection>

          <ReviewSection
            title="Escalações paradas"
            empty="Nada esperando resposta há mais de alguns dias."
          >
            {data.stalled_reviews.map((s) => (
              <li key={s.card_id} className="goal-overdue">
                <Link to={`/card/${s.card_id}`}>
                  <strong>{s.title}</strong>
                  <span className="where mono">{s.project}</span>
                  <span className="age mono">
                    há {s.days_stalled} dia{s.days_stalled === 1 ? '' : 's'}
                  </span>
                </Link>
              </li>
            ))}
          </ReviewSection>

          <p className="note">
            Concluídos vêm do log de auditoria: um card criado já em done, ou uma meta fechada
            editando o <code>_meta.json</code> à mão, não aparecem aqui.
            {!data.hours_estimate_available &&
              ' A estimativa de horas só existe para a semana corrente.'}
            {data.audit_truncated && ' O log foi lido só até o limite — pode faltar coisa.'}
          </p>
        </>
      ) : null}
    </div>
  )
}

function ReviewSection({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: React.ReactNode[]
}) {
  return (
    <section className="chart">
      <p className="label">{title}</p>
      {children.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ul className="pending">{children}</ul>
      )}
    </section>
  )
}

/** "6 de julho — 12 de julho" */
function rangeLabel(weekStart: string): string {
  const end = addDays(weekStart, 6)
  const at = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return rangeFmt.format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)))
  }
  return `${at(weekStart)} — ${at(end)}`
}
