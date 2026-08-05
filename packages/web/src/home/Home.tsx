import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ActivityResponse, Goal, ProjectActivity } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { subscribe } from '../api/events.js'
import type { useBoard } from '../board/useBoard.js'
import { Sparkline } from '../metrics/widgets.js'
import { fmtDay, humanTime, relativeTime, todayIso } from '../util/time.js'
import { goalUrgency, type GoalUrgency } from './goal-urgency.js'
import { buildOverview, type ProjectOverview } from './overview.js'

const WORKING_POLL_MS = 5000

/**
 * Grade de projetos — a Home cuidava disto E de "o que precisa de você",
 * misturando duas perguntas diferentes na mesma tela. A supervisão do vault
 * (pendências, agentes rodando, metas próximas, resumo da semana) mora agora
 * no dashboard em `/` (home/Dashboard.tsx); esta página responde só "quais
 * projetos existem e como estão".
 */
export function Home({
  client,
  board,
  onCreateProject,
  onPlanProject,
}: {
  client: KanbanClient
  board: ReturnType<typeof useBoard>
  onCreateProject: () => void
  onPlanProject?: () => void
}) {
  // Cards crus, não groups: groups aplicam filtro de sprint por projeto, e a
  // grade de projetos deve enxergar tudo.
  const overview = useMemo(
    () => buildOverview(board.cards, board.projects, board.escalations),
    [board.cards, board.projects, board.escalations],
  )

  // Contabilidade/custo mora na aba Estatísticas — a home fica só com o pulso
  // de atividade, mais barato de olhar de relance do que a tabela completa.
  // Idem para o pulso de 14 dias: snapshot basta, a home recarrega ao voltar.
  const [activity, setActivity] = useState<ActivityResponse | null>(null)
  useEffect(() => {
    void client.getActivity().then((res) => {
      if (res.ok) setActivity(res.data)
    })
  }, [client])

  const activityByProject = useMemo(
    () => new Map((activity?.projects ?? []).map((p) => [p.project, p])),
    [activity],
  )
  // Pico global: sparklines comparáveis ENTRE projetos — a mesma altura de
  // barra significa o mesmo volume em qualquer tile.
  const activityPeak = useMemo(
    () =>
      Math.max(
        1,
        ...(activity?.projects ?? []).flatMap((p) => p.days.map((d) => d.card_ops + d.commits)),
      ),
    [activity],
  )

  // "Agentes trabalhando" é status de execução (kanban_workflow_status), não
  // dado do board — por isso um poll leve à parte em vez de esperar o SSE de
  // cards, que não dispara quando só o workflow muda de fase.
  const working = useWorkingProjects(client, overview)

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
          <h1>Projetos</h1>
          <div className="detail-ident">
            <span>
              {overview.length} projeto{overview.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>

        <section className="project-grid" style={{ marginTop: 'var(--s-6)' }}>
          {overview.length === 0 && (
            <div className="empty-lg">
              <p>Nenhum projeto ainda.</p>
              {onPlanProject && (
                <button className="primary" onClick={onPlanProject}>
                  planejar um novo projeto
                </button>
              )}
              <button onClick={onCreateProject}>+ criar o primeiro projeto</button>
            </div>
          )}
          {overview.map((p) => (
            <ProjectCard
              key={p.project}
              p={p}
              activity={activityByProject.get(p.project)}
              peak={activityPeak}
              working={working.has(p.project)}
            />
          ))}
        </section>
      </div>
    </div>
  )
}

/**
 * Uma sprint ativa não significa agente rodando — o workflow pode estar
 * parado à espera de humano. Só `kanban_workflow_status` diz o estado real do
 * processo, daí o poll dedicado (o SSE de cards não dispara quando só a fase
 * do workflow muda).
 *
 * Exportado: o dashboard em `/` reusa o mesmo poll pra listar "projetos com
 * agentes rodando" sem duplicar a lógica de status.
 */
export function useWorkingProjects(
  client: KanbanClient,
  overview: readonly ProjectOverview[],
): ReadonlySet<string> {
  const [working, setWorking] = useState<ReadonlySet<string>>(new Set())

  const sprintByProject = useMemo(
    () =>
      overview
        .filter((p) => p.active !== null)
        .map((p) => ({ project: p.project, sprintId: p.active!.sprint.id })),
    [overview],
  )

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const results = await Promise.all(
        sprintByProject.map(async ({ project, sprintId }) => {
          const res = await client.workflowStatus(sprintId)
          return res.ok && res.data.run?.status === 'running' ? project : null
        }),
      )
      if (!cancelled) setWorking(new Set(results.filter((p): p is string => p !== null)))
    }
    void poll()
    const timer = setInterval(() => void poll(), WORKING_POLL_MS)
    const unsubscribe = subscribe((ev) => {
      switch (ev.type) {
        case 'WORKFLOW_STARTED':
        case 'WORKFLOW_EXITED':
        case 'JOB_STARTED':
        case 'JOB_FINISHED':
          void poll()
          break
      }
    })
    return () => {
      cancelled = true
      clearInterval(timer)
      unsubscribe()
    }
  }, [client, sprintByProject])

  return working
}

function ProjectCard({
  p,
  activity,
  peak,
  working,
}: {
  p: ProjectOverview
  activity: ProjectActivity | undefined
  peak: number
  working: boolean
}) {
  const alert = p.escalations.length + p.review.length
  const openGoals = p.goals.filter((g) => g.status === 'open')
  const today = todayIso()
  // Prazo apertado acende o tile mas fica fora do contador: "N decisões" conta
  // o que espera resposta agora, e somar prazo ali misturaria duas urgências
  // com tempos de resposta diferentes.
  const goalAlert = openGoals.some((g) => goalUrgency(g, today) !== 'ok')
  return (
    <Link
      className={`project-tile${alert > 0 || goalAlert ? ' alert' : ''}`}
      to={`/board/${p.project}`}
    >
      {working && <div className="pt-working">● agentes trabalhando</div>}
      <div className="pt-head">
        <h2>{p.project}</h2>
        {alert > 0 && (
          <span className="flag escalated">
            ▲ {alert} decis{alert === 1 ? 'ão' : 'ões'}
          </span>
        )}
      </div>
      {activity && (
        <div
          className="pt-pulse"
          title={activity.repo_unavailable ? 'sem repo configurado — só atividade de cards' : undefined}
        >
          <Sparkline days={activity.days} max={peak} />
          <span className="mono pt-hours">
            {activity.estimated_hours_week > 0
              ? `≈ ${activity.estimated_hours_week.toLocaleString('pt-BR')} h na semana`
              : 'sem atividade na semana'}
          </span>
        </div>
      )}
      {openGoals.length > 0 && (
        <ul className="pt-goals">
          {openGoals.map((g) => (
            <GoalLine key={g.id} goal={g} today={today} />
          ))}
        </ul>
      )}
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
        // Uma linha, sempre: a próxima sprint + contador. A lista completa é
        // assunto do board — aqui ela deformava o tile (e a linha do grid).
        <div className="pt-planned" title={p.planned.map((s) => s.name).join('\n')}>
          <span className="pill planning">planning</span>
          <span className="pt-planned-next">{p.planned[0]!.name}</span>
          {p.planned.length > 1 && (
            <span className="muted mono">
              +{p.planned.length - 1} sprint{p.planned.length - 1 === 1 ? '' : 's'}
            </span>
          )}
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

const URGENCY_MARK: Record<GoalUrgency, string> = { ok: '◇', 'due-soon': '◆', overdue: '▲' }

/**
 * Meta aberta num tile: título + prazo. Vencida e vencendo entram no canal de
 * alerta — são estados que pedem decisão (replanejar ou correr), não
 * decoração; o losango cheio separa "aperta" de "já passou" sem gastar um
 * quarto matiz.
 */
function GoalLine({ goal, today }: { goal: Goal; today: string }) {
  const urgency = goalUrgency(goal, today)
  return (
    <li className={urgency === 'ok' ? undefined : `goal-${urgency}`} title={goal.notes}>
      <span className="goal-mark">{URGENCY_MARK[urgency]}</span> {goal.title}
      {goal.target_date && (
        <span className="mono goal-date">
          {urgency === 'overdue' ? 'venceu ' : 'até '}
          {fmtDay(goal.target_date)}
        </span>
      )}
    </li>
  )
}
