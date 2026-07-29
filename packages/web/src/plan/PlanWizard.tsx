import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type {
  PlanningChoicePayload,
  PlanningConfirmPayload,
  PlanningDiagramPayload,
  PlanningFinalizeResult,
  PlanningFormPayload,
  PlanningListPayload,
  PlanningSessionView,
} from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText, type McpResult } from '../api/result.js'
import { Tile } from '../metrics/widgets.js'
import { Readiness } from '../ui/ProjectPanel.js'
import { PLAN_PHASES, PLAN_STEPS, stepIndex, stepMeta } from './steps-meta.js'
import { usePlanning } from './usePlanning.js'
import { StepChoice, StepConfirm, StepDiagram, StepForm, StepList } from './screens.js'

/**
 * Wizard "Planejar um novo projeto": sem :sessionId retoma a sessão ativa (ou
 * cria uma); com :sessionId renderiza a etapa atual. O conteúdo das telas vem
 * do servidor; aqui só se renderiza, responde e refina.
 */
export function PlanEntry({ client }: { client: KanbanClient }) {
  const navigate = useNavigate()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const listed = await client.planningList()
      if (!alive) return
      if (listed.ok && listed.data.sessions.length > 0) {
        navigate(`/planejar/${listed.data.sessions[0]!.session_id}`, { replace: true })
        return
      }
      const started = await client.planningStart()
      if (!alive) return
      if (started.ok) navigate(`/planejar/${started.data.session_id}`, { replace: true })
      else setError(errorText(started.error))
    })()
    return () => {
      alive = false
    }
  }, [client, navigate])

  if (error) return <p className="banner">{error}</p>
  return <p className="empty-lg">preparando o planejamento…</p>
}

export function PlanWizard({ client }: { client: KanbanClient }) {
  const { sessionId = '' } = useParams()
  const { session, error, loading, reload, setSession, setError } = usePlanning(client, sessionId)
  const [busy, setBusy] = useState(false)
  const [finalized, setFinalized] = useState<PlanningFinalizeResult | null>(null)

  async function act(fn: () => Promise<McpResult<PlanningSessionView>>) {
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
    const res = await client.planningFinalize(sessionId)
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

  const meta = stepMeta(session.current_step)
  const idx = stepIndex(session.current_step)
  const phaseIdx = meta ? PLAN_PHASES.findIndex((p) => p.id === meta.phase) : 0
  const reviewAnswered = session.current_step === 'review' && session.answers['review'] !== undefined
  const payload = session.outputs[session.current_step]?.screen_payload

  return (
    <div className="detail">
      <div className="detail-inner wide wizard">
        <div className="detail-head">
          <h1>Planejar um novo projeto</h1>
          {session.project_name && <span className="detail-ident mono">{session.project_name}</span>}
        </div>

        {/* Progresso em dois níveis: as 4 fases nomeadas + a contagem exata.
            15 etapas viravam um breadcrumb ilegível em duas linhas. */}
        <div className="wizard-progress">
          <p className="wizard-count mono">
            etapa {idx + 1} de {PLAN_STEPS.length}
            {meta && ` — ${meta.title}`}
          </p>
          <div className="wizard-bar" role="presentation">
            <span style={{ width: `${((idx + 1) / PLAN_STEPS.length) * 100}%` }} />
          </div>
          <ol className="wizard-steps" aria-label="fases do planejamento">
            {PLAN_PHASES.map((p, i) => (
              <li
                key={p.id}
                className={i < phaseIdx ? 'done' : i === phaseIdx ? 'current' : ''}
                aria-current={i === phaseIdx ? 'step' : undefined}
              >
                {p.title}
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
              o arquiteto está escrevendo esta etapa… (turno {session.usage.turns + 1})
            </p>
          )}

          {session.status === 'error' && (
            <div className="wizard-error">
              <p className="banner">
                {session.last_error === 'rate_limit'
                  ? 'limite de uso do modelo atingido — tente de novo em alguns minutos'
                  : `a geração falhou: ${session.last_error ?? 'erro desconhecido'}`}
              </p>
              {/* cancelar já existe no rodapé do wizard — aqui só a saída de recuperação */}
              <div className="form-row">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    session.last_error?.startsWith('materialização')
                      ? void finalize()
                      : void act(() => client.planningRetry(sessionId))
                  }
                >
                  tentar de novo
                </button>
              </div>
            </div>
          )}

          {session.status === 'done' && !finalized && (
            <p className="empty-lg">
              Planejamento concluído.{' '}
              {session.project_name && (
                <Link to={`/board/${session.project_name}`}>abrir o board →</Link>
              )}
            </p>
          )}

          {session.status === 'awaiting_user' && reviewAnswered && (
            <div className="wizard-generated">
              <p>
                Plano aprovado. Materializar cria o projeto, os épicos, as sprints e os cards, e
                grava os documentos KAD no vault{session.target_repo ? ' e no repositório' : ''}.
              </p>
              <div className="form-row">
                <div className="spacer" />
                <button className="primary" disabled={busy} onClick={() => void finalize()}>
                  Materializar projeto
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
                void act(() => client.planningAnswer(sessionId, session.current_step, answer))
              }
              onRefine={(feedback) => void act(() => client.planningRefine(sessionId, feedback))}
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
                if (confirm('Cancelar este planejamento? A sessão não pode ser retomada.')) {
                  void client.planningCancel(sessionId).then(() => void reload())
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
    case 'list':
      return <StepList payload={payload as PlanningListPayload} busy={busy} onSubmit={onSubmit} />
    case 'diagram':
      return (
        <StepDiagram
          payload={payload as PlanningDiagramPayload}
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
          confirmLabel={isReview ? 'Aprovar plano' : 'Confirmar e continuar'}
          onSubmit={onSubmit}
          onRefine={onRefine}
        />
      )
  }
}

function FinalizeSummary({ r }: { r: PlanningFinalizeResult }) {
  return (
    <div className="detail">
      <div className="detail-inner wide wizard">
        <div className="detail-head">
          <h1>Projeto criado</h1>
          <span className="detail-ident mono">{r.project}</span>
        </div>
        <section className="wizard-body">
          <div className="tiles">
            <Tile label="épicos" value={String(r.epics)} />
            <Tile label="sprints" value={String(r.sprints)} />
            <Tile label="cards" value={String(r.cards_created)} />
            <Tile label="metas" value={String(r.goals)} muted={r.goals === 0} />
            <Tile label="docs KAD" value={String(r.kad_files.length)} />
          </div>
          {r.repo_copy_ok === false && (
            <p className="banner">a cópia dos documentos KAD para o repositório falhou</p>
          )}
          {r.cards_failed.length > 0 && (
            <p className="banner">
              {r.cards_failed.length} card(s) falharam:{' '}
              {r.cards_failed.map((f) => `${f.sprint}#${f.index} (${f.error})`).join(', ')}
            </p>
          )}
          {/* O token cru nunca é exibido: com repo, o provisionamento implanta os
              tokens em .claude/settings.local.json; sem repo, o caminho é setar
              o repositório — que provisiona tudo — e não copiar segredo da tela. */}
          {r.workflow_readiness ? (
            <Readiness r={r.workflow_readiness} />
          ) : (
            <p className="field-help" style={{ marginTop: 'var(--s-5)' }}>
              Falta definir o repositório de trabalho: use kanban_set_project_repo com um caminho
              absoluto. Isso instala as skills do workflow e implanta os tokens dos agentes (pm e
              dev) direto no repositório — sem copiar credenciais manualmente.
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
