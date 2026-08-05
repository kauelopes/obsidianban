import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { CardSummary, EscalationItem, WeeklyDigest } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import type { useBoard } from '../board/useBoard.js'
import { Tile } from '../metrics/widgets.js'
import { Markdown } from '../markdown/Markdown.js'
import { stepIndex, stepMeta, PLAN_STEPS } from '../plan/steps-meta.js'
import { usePlanningSummary } from '../plan/usePlanningSummary.js'
import { fmtDay, mondayOf, relativeTime, todayIso } from '../util/time.js'
import { goalUrgency } from './goal-urgency.js'
import { useWorkingProjects } from './Home.js'
import { buildOverview, compareEscalation, compareReview, mergeCards } from './overview.js'

/**
 * Hub de supervisão do vault inteiro — a Home antes disto só listava projetos
 * (era, na prática, a página "Projetos"). Este dashboard responde "o que
 * precisa de mim agora", não "quais projetos existem": pendências primeiro
 * (escalações + cards em review, com as mesmas ações que a Inbox oferecia),
 * depois onde os agentes estão trabalhando, as metas mais próximas do prazo,
 * e um resumo raso da última semana. Cada bloco linka para a página funda
 * correspondente (board do projeto, Horizonte, Estatísticas) em vez de
 * duplicar a experiência completa.
 */
export function Dashboard({
  client,
  board,
}: {
  client: KanbanClient
  board: ReturnType<typeof useBoard>
}) {
  // A janela de 200 do board pode deixar cards em review de fora — e um falso
  // "nada esperando você" é o pior erro que este painel pode cometer. Um
  // snapshot dedicado por status cobre o mount; dali em diante o SSE upserta
  // mudanças no board.cards, que ganha do snapshot no merge.
  const [reviewSnapshot, setReviewSnapshot] = useState<readonly CardSummary[]>([])
  const loadReviewSnapshot = useCallback(async () => {
    const res = await client.listCards({ status: 'review', limit: 200 })
    if (res.ok) setReviewSnapshot(res.data.cards)
  }, [client])
  useEffect(() => {
    void loadReviewSnapshot()
  }, [loadReviewSnapshot])

  const overview = useMemo(
    () =>
      buildOverview(mergeCards(board.cards, reviewSnapshot), board.projects, board.escalations),
    [board.cards, reviewSnapshot, board.projects, board.escalations],
  )

  const pendingReview = overview.flatMap((p) => p.review).sort(compareReview)
  const pendingEscalations = overview.flatMap((p) => p.escalations).sort(compareEscalation)
  const needsYou = pendingReview.length + pendingEscalations.length
  const planning = usePlanningSummary(client)
  const working = useWorkingProjects(client, overview)

  // A aba fica aberta enquanto agentes trabalham; o badge no título é o que
  // avisa sem exigir alternar para cá.
  useEffect(() => {
    document.title = needsYou > 0 ? `(${needsYou}) ObsidianKan` : 'ObsidianKan'
    return () => {
      document.title = 'ObsidianKan'
    }
  }, [needsYou])

  const workingProjects = overview.filter((p) => working.has(p.project))

  const upcomingGoals = useMemo(() => {
    const today = todayIso()
    return overview
      .flatMap((p) => p.goals.filter((g) => g.status === 'open').map((g) => ({ project: p.project, goal: g })))
      .filter(({ goal }) => goalUrgency(goal, today) !== 'ok' || goal.target_date !== null)
      .sort((a, b) => {
        const ua = goalUrgency(a.goal, today)
        const ub = goalUrgency(b.goal, today)
        if (ua !== ub) return ua === 'overdue' ? -1 : ub === 'overdue' ? 1 : ua === 'due-soon' ? -1 : 1
        return (a.goal.target_date ?? '').localeCompare(b.goal.target_date ?? '')
      })
      .slice(0, 6)
  }, [overview])

  const [digest, setDigest] = useState<WeeklyDigest | null>(null)
  useEffect(() => {
    void client.getDigest({ week_start: mondayOf(todayIso()) }).then((res) => {
      if (res.ok) setDigest(res.data)
    })
  }, [client])

  if (board.loading) {
    return (
      <div className="detail">
        <p className="empty-lg">carregando…</p>
      </div>
    )
  }

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Home</h1>
          <div className="detail-ident">
            <span>o que precisa de você agora</span>
          </div>
        </div>

        <div className="home-grid">
          <aside className="home-side">
            {needsYou > 0 ? (
              <NeedsYou
                client={client}
                escalations={pendingEscalations}
                review={pendingReview}
                onResolved={() => {
                  board.reload()
                  void loadReviewSnapshot()
                }}
              />
            ) : (
              <AllClear overview={overview} />
            )}
            {planning && (
              <section className="home-plan">
                <p className="label">planejamento em curso</p>
                <Link to={`/planejar/${planning.session_id}`}>
                  <span className="pill planning">planning</span>
                  <strong>{planning.project_name ?? 'novo projeto'}</strong>
                  {stepMeta(planning.current_step) && (
                    <span className="mono muted">
                      etapa {stepIndex(planning.current_step) + 1} de {PLAN_STEPS.length} —{' '}
                      {stepMeta(planning.current_step)!.title}
                    </span>
                  )}
                </Link>
              </section>
            )}
          </aside>

          <div className="home-main">
            <section className="chart">
              <p className="label">projetos com agentes trabalhando</p>
              {workingProjects.length === 0 ? (
                <p className="empty">Nenhum agente rodando agora.</p>
              ) : (
                <ul className="pending">
                  {workingProjects.map((p) => (
                    <li key={p.project}>
                      <Link to={`/board/${p.project}`}>
                        <span className="flag review">● agentes trabalhando</span>
                        <strong>{p.project}</strong>
                        {p.active && <span className="mono where">{p.active.sprint.name}</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="chart">
              <p className="label">próximas metas</p>
              {upcomingGoals.length === 0 ? (
                <p className="empty">Nenhuma meta com prazo se aproximando.</p>
              ) : (
                <ul className="pending">
                  {upcomingGoals.map(({ project, goal }) => (
                    <li key={`${project}/${goal.id}`} className={goalUrgency(goal, todayIso()) !== 'ok' ? `goal-${goalUrgency(goal, todayIso())}` : undefined}>
                      <Link to="/horizonte">
                        <strong>{goal.title}</strong>
                        <span className="mono where">{project}</span>
                        {goal.target_date && (
                          <span className="age mono">
                            {goalUrgency(goal, todayIso()) === 'overdue' ? 'venceu ' : 'até '}
                            {fmtDay(goal.target_date)}
                          </span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              <p className="note">
                <Link to="/horizonte">ver todas as metas no Horizonte →</Link>
              </p>
            </section>

            <section className="chart">
              <p className="label">última semana</p>
              {digest ? (
                <>
                  <div className="tiles">
                    <Tile label="sprints fechadas" value={String(digest.sprints_closed.length)} />
                    <Tile label="cards concluídos" value={String(digest.cards_done.length)} />
                    <Tile label="metas concluídas" value={String(digest.goals_done.length)} />
                  </div>
                  <p className="note">
                    <Link to="/atividade">ver revisão completa da semana em Estatísticas →</Link>
                  </p>
                </>
              ) : (
                <p className="empty">carregando…</p>
              )}
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Pendências que esperam decisão humana — dobra aqui o que antes era a
 * página Escalações (Inbox): mesmas duas saídas da triagem automática do
 * sprint workflow (CLOSE/RETURN, ver TRIAGE_SYSTEM em
 * scripts/sprint-workflow.ts). Cards em review sem motivo de escalação
 * (movidos manualmente) só têm o link — não há "decisão" pra registrar ali.
 */
function NeedsYou({
  client,
  escalations,
  review,
  onResolved,
}: {
  client: KanbanClient
  escalations: readonly EscalationItem[]
  review: readonly CardSummary[]
  onResolved: () => void
}) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [reply, setReply] = useState('')
  const [error, setError] = useState<string | null>(null)

  const escalatedIds = new Set(escalations.map((e) => e.card_id))
  const plainReview = review.filter((c) => !escalatedIds.has(c.id))
  const needsYou = escalations.length + review.length

  async function resolve(cardId: string, version: number, text: string, outcome: 'close' | 'return') {
    setBusyId(cardId)
    setError(null)

    const logged = await client.logOnCard({
      id: cardId,
      version,
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
      const moved = await client.moveCard({
        id: cardId,
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
    onResolved()
  }

  return (
    <section className="needs-you">
      <p className="label">
        precisa de você — {needsYou} {needsYou === 1 ? 'item' : 'itens'}
      </p>
      {error && <p className="banner">{error}</p>}
      <ul className="pending inbox">
        {escalations.map((e) => (
          <li className="inbox-item" key={`esc-${e.card_id}`}>
            <div className="inbox-head">
              <Link className="inbox-title" to={`/card/${e.card_id}`}>
                {e.title}
              </Link>
              <span className={`prio ${e.priority}`}>{e.priority}</span>
              <div className="spacer" />
              <span className="mono inbox-meta">
                {e.project} · esperando {relativeTime(e.escalated_at ?? e.updated_at)}
              </span>
            </div>
            {e.reason && (
              <div className="inbox-reason">
                <Markdown>{e.reason}</Markdown>
              </div>
            )}
            {replyTo === e.card_id ? (
              <div className="editor">
                <textarea
                  autoFocus
                  value={reply}
                  rows={3}
                  placeholder="Sua decisão. Vai para o Agent Log como pm_resolved."
                  onChange={(ev) => setReply(ev.target.value)}
                />
                <div className="actions">
                  <button
                    className="primary"
                    disabled={busyId === e.card_id || !reply.trim()}
                    onClick={() => void resolve(e.card_id, e.version, reply.trim(), 'close')}
                    title="CLOSE — o trabalho está genuinamente concluído"
                  >
                    Concluir
                  </button>
                  <button
                    disabled={busyId === e.card_id || !reply.trim()}
                    onClick={() => void resolve(e.card_id, e.version, reply.trim(), 'return')}
                    title="RETURN — você resolveu o bloqueio, o dev agent pode continuar"
                  >
                    Devolver ao todo
                  </button>
                  <button
                    disabled={busyId === e.card_id}
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
                    setReplyTo(e.card_id)
                    setReply('')
                  }}
                >
                  Responder
                </button>
                <Link to={`/card/${e.card_id}`}>
                  <button disabled={busyId !== null}>Abrir card</button>
                </Link>
              </div>
            )}
          </li>
        ))}
        {plainReview.map((c) => (
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
  )
}

/**
 * "Tudo em ordem" é o melhor resultado que este painel entrega — merece
 * presença, não silêncio. E um hub vazio de pendência aponta o próximo passo
 * útil: a sprint mais próxima de precisar de um plano revisado.
 */
function AllClear({ overview }: { overview: ReturnType<typeof buildOverview> }) {
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
