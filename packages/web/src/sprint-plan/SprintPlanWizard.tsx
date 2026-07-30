import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type {
  PlanningChoicePayload,
  PlanningConfirmPayload,
  PlanningFormPayload,
  PlanningTaskListPayload,
  SprintPlanningFinalizeResult,
  SprintPlanningSessionView,
} from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText, type McpResult } from '../api/result.js'
import { Tile } from '../metrics/widgets.js'
import { SPRINT_STEPS, sprintStepIndex, sprintStepMeta } from './steps-meta.js'
import { useSprintPlanning } from './useSprintPlanning.js'
import { StepChoice, StepConfirm, StepForm, StepTaskList } from '../plan/screens.js'

/**
 * Wizard "Criar sprint com assistente": sem :sessionId retoma a sessão ativa
 * do projeto (ou cria uma); com :sessionId renderiza a etapa atual. O
 * conteúdo das telas vem do servidor; aqui só se renderiza, responde e refina.
 */
export function SprintPlanEntry({ client }: { client: KanbanClient }) {
  const { project = '' } = useParams()
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const listed = await client.sprintPlanningList(project)
      if (!alive) return
      if (listed.ok && listed.data.sessions.length > 0) {
        navigate(`/planejar-sprint/${listed.data.sessions[0]!.session_id}`, { replace: true })
        return
      }
      const started = await client.sprintPlanningStart(project)
      if (!alive) return
      if (started.ok) navigate(`/planejar-sprint/${started.data.session_id}`, { replace: true })
      else setError(errorText(started.error))
    })()
    return () => {
      alive = false
    }
  }, [client, project, navigate])

  if (error) return <p className="banner">{error}</p>
  return <p className="empty-lg">preparando o planejamento da sprint…</p>
}

export function SprintPlanWizard({ client }: { client: KanbanClient }) {
  const { sessionId = '' } = useParams()
  const { session, error, loading, reload, setSession, setError } = useSprintPlanning(client, sessionId)
  const [busy, setBusy] = useState(false)
  const [finalized, setFinalized] = useState<SprintPlanningFinalizeResult | null>(null)

  async function act(fn: () => Promise<McpResult<SprintPlanningSessionView>>) {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (res.ok) {
      setSession(res.data)
      setError(null)
      void reload()
    } else {
      setError(errorText(res.error))
    }
  }

  async function finalize() {
    setBusy(true)
    const res = await client.sprintPlanningFinalize(sessionId)
    setBusy(false)
    if (res.ok) {
      setFinalized(res.data)
      void reload()
    } else {
      setError(errorText(res.error))
      void reload()
    }
  }

  if (loading) return <p className="empty-lg">carregando a sessão…</p>
  if (!session) return <p className="banner">{error ?? 'sessão não encontrada'}</p>

  if (finalized) return <FinalizeSummary r={finalized} />

  const meta = sprintStepMeta(session.current_step)
  const idx = sprintStepIndex(session.current_step)
  const reviewAnswered = session.current_step === 'review' && session.answers['review'] !== undefined
  const payload = session.outputs[session.current_step]?.screen_payload

  return (
    <div className="detail">
      <div className="detail-inner wide wizard">
        <div className="detail-head">
          <h1>Criar sprint com assistente</h1>
          <span className="detail-ident mono">{session.project}</span>
        </div>

        <div className="wizard-progress">
          <p className="wizard-count mono">
            etapa {idx + 1} de {SPRINT_STEPS.length}
            {meta && ` — ${meta.title}`}
          </p>
          <div className="wizard-bar" role="presentation">
            <span style={{ width: `${((idx + 1) / SPRINT_STEPS.length) * 100}%` }} />
          </div>
          <ol className="wizard-steps" aria-label="etapas do planejamento">
            {SPRINT_STEPS.map((s, i) => (
              <li
                key={s.id}
                className={i < idx ? 'done' : i === idx ? 'current' : ''}
                aria-current={i === idx ? 'step' : undefined}
              >
                {s.title}
              </li>
            ))}
          </ol>
        </div>

        {error && (
          <p className="banner">
            {error}
            <button className="ghost" onClick={() => setError(null)}>
              fechar
            </button>
          </p>
        )}

        <section className="wizard-body">
          {meta && <h2>{meta.title}</h2>}

          {session.status === 'generating' && (
            <p className="wizard-generating mono" role="status">
              o facilitador está escrevendo esta etapa… (turno {session.usage.turns + 1})
            </p>
          )}

          {session.status === 'error' && (
            <div className="wizard-error">
              <p className="banner">
                {session.last_error === 'rate_limit'
                  ? 'limite de uso do modelo atingido — tente de novo em alguns minutos'
                  : `a geração falhou: ${session.last_error ?? 'erro desconhecido'}`}
              </p>
              <div className="form-row">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    session.last_error?.startsWith('materialização')
                      ? void finalize()
                      : void act(() => client.sprintPlanningRetry(sessionId))
                  }
                >
                  tentar de novo
                </button>
              </div>
            </div>
          )}

          {session.status === 'done' && !finalized && (
            <p className="empty-lg">
              Sprint criada. <Link to={`/board/${session.project}`}>abrir o board →</Link>
            </p>
          )}

          {session.status === 'awaiting_user' && reviewAnswered && (
            <div className="wizard-generated">
              <p>Sprint aprovada. Materializar cria a sprint e as tarefas no board.</p>
              <div className="form-row">
                <div className="spacer" />
                <button className="primary" disabled={busy} onClick={() => void finalize()}>
                  Materializar sprint
                </button>
              </div>
            </div>
          )}

          {session.status === 'awaiting_user' && !reviewAnswered && meta && payload != null && (
            <StepScreen
              key={session.current_step}
              screen={meta.screen}
              isReview={session.current_step === 'review'}
              payload={payload}
              busy={busy}
              onSubmit={(answer) =>
                void act(() => client.sprintPlanningAnswer(sessionId, session.current_step, answer))
              }
              onRefine={(feedback) => void act(() => client.sprintPlanningRefine(sessionId, feedback))}
            />
          )}
        </section>

        <footer className="wizard-foot">
          <span className="mono muted">
            {session.usage.turns} turnos · {session.usage.input_tokens + session.usage.output_tokens}{' '}
            tokens · ≈ ${session.usage.usd.toFixed(2)}
          </span>
          {session.status !== 'done' && session.status !== 'cancelled' && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm('Cancelar este planejamento de sprint? A sessão não pode ser retomada.')) {
                  void client.sprintPlanningCancel(sessionId).then(() => void reload())
                }
              }}
            >
              cancelar planejamento
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}

function StepScreen({
  screen,
  isReview,
  payload,
  busy,
  onSubmit,
  onRefine,
}: {
  screen: string
  isReview: boolean
  payload: unknown
  busy: boolean
  onSubmit: (answer: unknown) => void
  onRefine: (feedback: string) => void
}) {
  switch (screen) {
    case 'form':
      return <StepForm payload={payload as PlanningFormPayload} busy={busy} onSubmit={onSubmit} />
    case 'choice':
      return <StepChoice payload={payload as PlanningChoicePayload} busy={busy} onSubmit={onSubmit} />
    case 'task_list':
      return (
        <StepTaskList
          payload={payload as PlanningTaskListPayload}
          busy={busy}
          onSubmit={onSubmit}
          onRefine={onRefine}
        />
      )
    default:
      return (
        <StepConfirm
          payload={payload as PlanningConfirmPayload}
          busy={busy}
          confirmLabel={isReview ? 'Aprovar sprint' : 'Confirmar e continuar'}
          onSubmit={onSubmit}
          onRefine={onRefine}
        />
      )
  }
}

function FinalizeSummary({ r }: { r: SprintPlanningFinalizeResult }) {
  return (
    <div className="detail">
      <div className="detail-inner wide wizard">
        <div className="detail-head">
          <h1>Sprint criada</h1>
          <span className="detail-ident mono">{r.project}</span>
        </div>
        <section className="wizard-body">
          <div className="tiles">
            <Tile label="tarefas criadas" value={String(r.new_cards_created)} />
            <Tile label="vinculada a épico" value={r.epic_linked ? 'sim' : 'não'} muted={!r.epic_linked} />
          </div>
          {r.new_cards_failed.length > 0 && (
            <p className="banner">
              {r.new_cards_failed.length} tarefa(s) falharam:{' '}
              {r.new_cards_failed.map((f) => `#${f.index} (${f.error})`).join(', ')}
            </p>
          )}
          <p style={{ marginTop: 'var(--s-5)' }}>
            <Link to={`/board/${r.project}`}>abrir o board →</Link>
          </p>
        </section>
      </div>
    </div>
  )
}
