import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  estimateUsd,
  providerOf,
  type Metrics as MetricsData,
  type ModelProvider,
} from '@obsidiankan/types'
import type { CardSummary } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import type { useBoard } from '../board/useBoard.js'
import { humanTime, relativeTime } from '../util/time.js'
import {
  buildOverview,
  compareEscalation,
  compareReview,
  mergeCards,
  type ProjectOverview,
} from './overview.js'

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  other: 'outros',
}

/**
 * Hub de supervisão. Ordem das seções = urgência: o que espera decisão humana
 * vem antes do estado dos projetos, que vem antes da contabilidade.
 */
export function Home({
  client,
  board,
  onCreateProject,
}: {
  client: KanbanClient
  board: ReturnType<typeof useBoard>
  onCreateProject: () => void
}) {
  // A janela de 200 do board pode deixar cards em review de fora — e um falso
  // "nada esperando você" é o pior erro que esta página pode cometer. Um
  // snapshot dedicado por status cobre o mount; dali em diante o SSE upserta
  // mudanças no board.cards, que ganha do snapshot no merge.
  const [reviewSnapshot, setReviewSnapshot] = useState<readonly CardSummary[]>([])
  useEffect(() => {
    void client.listCards({ status: 'review', limit: 200 }).then((res) => {
      if (res.ok) setReviewSnapshot(res.data.cards)
    })
  }, [client])

  // Cards crus, não groups: groups aplicam filtro de sprint por projeto, e o
  // resumo da home deve enxergar tudo.
  const overview = useMemo(
    () =>
      buildOverview(mergeCards(board.cards, reviewSnapshot), board.projects, board.escalations),
    [board.cards, reviewSnapshot, board.projects, board.escalations],
  )

  // Snapshot no mount: contabilidade não precisa de SSE.
  const [metrics, setMetrics] = useState<MetricsData | null>(null)
  useEffect(() => {
    void client.getMetrics().then((res) => {
      if (res.ok) setMetrics(res.data)
    })
  }, [client])

  const pendingReview = overview.flatMap((p) => p.review).sort(compareReview)
  const pendingEscalations = overview.flatMap((p) => p.escalations).sort(compareEscalation)
  const needsYou = pendingReview.length + pendingEscalations.length

  // A aba fica aberta enquanto agentes trabalham; o badge no título é o que
  // avisa sem exigir alternar para cá.
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) ObsidianKan` : 'ObsidianKan'
    return () => {
      document.title = 'ObsidianKan'
    }
  }, [needsYou])

  if (board.loading) {
    return (
      <div className="detail">
        <p className="empty-lg">carregando…</p>
      </div>
    )
  }

  return (
    <div className="detail">
      <div className="detail-inner">
        <div className="detail-head">
          <h1>Projetos</h1>
          <div className="detail-ident">
            <span>
              {overview.length} projeto{overview.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        {needsYou > 0 ? (
          <section className="needs-you">
            <p className="label">
              precisa de você — {needsYou} {needsYou === 1 ? 'item' : 'itens'}
            </p>
            <ul className="pending">
              {pendingEscalations.map((e) => (
                <li key={`esc-${e.card_id}`}>
                  <Link to={`/card/${e.card_id}`}>
                    <span className="flag escalated">▲ escalado</span>
                    <strong>{e.title}</strong>
                    <span className="mono where">{e.project}</span>
                    <span className="age">
                      esperando {relativeTime(e.escalated_at ?? e.updated_at)}
                    </span>
                    {e.reason && <span className="why">{truncate(e.reason, 90)}</span>}
                  </Link>
                </li>
              ))}
              {pendingReview.map((c) => (
                <li key={`rev-${c.id}`}>
                  <Link to={`/card/${c.id}`}>
                    <span className="flag review">● review</span>
                    <strong>{c.title}</strong>
                    <span className="mono where">{c.project}</span>
                    <span className={`prio ${c.priority}`}>{c.priority}</span>
                    <span className="age">esperando {relativeTime(c.updated_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          overview.length > 0 && <AllClear overview={overview} />
        )}

        <section className="project-grid">
          {overview.length === 0 && (
            <div className="empty-lg">
              <p>Nenhum projeto ainda.</p>
              <button onClick={onCreateProject}>+ criar o primeiro projeto</button>
            </div>
          )}
          {overview.map((p) => (
            <ProjectCard key={p.project} p={p} />
          ))}
        </section>

        {metrics && <Usage metrics={metrics} />}
      </div>
    </div>
  )
}

/**
 * "Tudo em ordem" é o melhor resultado que esta página entrega — merece
 * presença, não silêncio. E um hub vazio de pendência aponta o próximo passo
 * útil: a sprint mais próxima de precisar de um plano revisado.
 */
function AllClear({ overview }: { overview: readonly ProjectOverview[] }) {
  const next = overview.find((p) => p.planned.length > 0)
  return (
    <section className="all-clear">
      <p className="headline">Nada esperando você.</p>
      {next ? (
        <p className="next">
          Próximo passo: <Link to={`/board/${next.project}`}>{next.planned[0]!.name}</Link> está
          em planejamento em <span className="mono">{next.project}</span> — revisar o plano.
        </p>
      ) : (
        <p className="next">Os agentes seguem com o que está em andamento.</p>
      )}
    </section>
  )
}

function ProjectCard({ p }: { p: ProjectOverview }) {
  const alert = p.escalations.length + p.review.length
  return (
    <Link className={`project-tile${alert > 0 ? ' alert' : ''}`} to={`/board/${p.project}`}>
      <div className="pt-head">
        <h2>{p.project}</h2>
        {alert > 0 && (
          <span className="flag escalated">
            ▲ {alert} decis{alert === 1 ? 'ão' : 'ões'}
          </span>
        )}
      </div>
      <div className="pt-counts mono">
        {p.statusCounts.map(({ status, count }) => (
          <span key={status} className={count === 0 ? 'muted' : undefined}>
            {status.replace(/_/g, ' ')} {count}
          </span>
        ))}
      </div>
      {p.active ? (
        <div className="pt-sprint">
          <span className="pill active">active</span>
          <span className="pt-sprint-name">{p.active.sprint.name}</span>
          <span className="mono">
            {p.active.done}/{p.active.total} done
          </span>
        </div>
      ) : (
        <div className="pt-sprint">
          <span className="muted">sem sprint ativa</span>
        </div>
      )}
      {p.planned.length > 0 && (
        <div className="pt-planned">
          {p.planned.map((s) => (
            <span key={s.id} title={s.goal ?? undefined}>
              <span className="pill planning">planning</span> {s.name}
              {s.goal ? <span className="muted"> — {truncate(s.goal, 60)}</span> : null}
            </span>
          ))}
        </div>
      )}
      {p.lastUpdate && (
        <div className="pt-updated mono" title={humanTime(p.lastUpdate)}>
          atualizado {relativeTime(p.lastUpdate)}
        </div>
      )}
    </Link>
  )
}

/**
 * Uso agregado por provedor e por projeto. O custo é ESTIMADO por tabela local
 * de preços — modelos fora dela (human, unknown…) não entram na conta.
 */
function Usage({ metrics }: { metrics: MetricsData }) {
  const providers = useMemo(() => {
    const acc = new Map<ModelProvider, { input: number; output: number; usd: number; models: string[] }>()
    for (const row of metrics.by_model) {
      const prov = providerOf(row.model)
      const cur = acc.get(prov) ?? { input: 0, output: 0, usd: 0, models: [] }
      cur.input += row.input_tokens
      cur.output += row.output_tokens
      cur.usd += estimateUsd(row.model, row.input_tokens, row.output_tokens) ?? 0
      cur.models.push(row.model)
      acc.set(prov, cur)
    }
    return acc
  }, [metrics])

  const reported = metrics.summary.total_input_tokens + metrics.summary.total_output_tokens

  return (
    <section className="chart">
      <p className="label">uso por provedor</p>
      {reported === 0 ? (
        <p className="empty">nenhum token reportado — detalhes na página Atividade</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>provedor</th>
              <th className="num">entrada</th>
              <th className="num">saída</th>
              <th className="num">custo estimado ≈</th>
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

      {metrics.by_project.length > 0 && (
        <>
          <p className="label" style={{ marginTop: 'var(--s-6)' }}>
            operações por projeto
          </p>
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
        </>
      )}
    </section>
  )
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}
