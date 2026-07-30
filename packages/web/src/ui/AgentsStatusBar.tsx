import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  JobView,
  Sprint,
  WorkflowAgentsStatus,
  WorkflowInProgressCard,
  WorkflowLastTool,
  WorkflowRunView,
} from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { subscribe } from '../api/events.js'
import { errorText } from '../api/result.js'
import { Dialog } from './Dialog.js'

const STATUS_POLL_MS = 3000
const LOG_POLL_MS = 2500
// Mesmo limiar do antigo WorkflowPanel — ver docs/for-agents/sprint-workflow.md:
// gaps de 1-2min entre cards são normais só pelo tempo de "pensar" do modelo.
const IDLE_WARN_MS = 5 * 60 * 1000

const PHASE_LABEL: Record<WorkflowAgentsStatus['phase'], string> = {
  triage: 'triando review',
  dev: 'dev trabalhando',
  idle: 'ocioso entre rodadas',
}

/**
 * Barra persistente no topo do board com o que os agentes da sprint ativa
 * estão fazendo agora — substitui o antigo caminho Board → Sprints →
 * "agentes", que escondia essa informação a três cliques de distância.
 */
export function AgentsStatusBar({
  client,
  project,
  sprints,
}: {
  client: KanbanClient
  project: string
  sprints: readonly Sprint[]
}) {
  const active = sprints.find((s) => s.status === 'active')
  if (!active) {
    return (
      <div className="agents-bar">
        <span className="pill">nenhuma sprint ativa</span>
      </div>
    )
  }
  // key força reset de todo o estado de polling ao trocar de sprint ativa.
  return <ActiveAgentsBar key={active.id} client={client} project={project} sprintId={active.id} />
}

function ActiveAgentsBar({
  client,
  project,
  sprintId,
}: {
  client: KanbanClient
  project: string
  sprintId: string
}) {
  const [status, setStatus] = useState<WorkflowAgentsStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  const poll = useCallback(async () => {
    const res = await client.getWorkflowAgentsStatus(sprintId, project)
    if (res.ok) {
      setStatus(res.data)
      setError(null)
    } else if (res.error.kind === 'server' || res.error.kind === 'offline') {
      // Engolir isto deixaria a barra muda num servidor sem as tools de
      // workflow (processo antigo) — o erro é a informação mais útil que temos.
      setError(
        res.error.kind === 'server' && res.error.status === 501
          ? 'O servidor em execução não tem as tools de agentes — reinicie o servidor kanban para carregar o código novo.'
          : errorText(res.error),
      )
    }
  }, [client, sprintId, project])

  useEffect(() => {
    setStatus(null)
    void poll()
    const timer = setInterval(() => void poll(), STATUS_POLL_MS)
    return () => clearInterval(timer)
  }, [poll])

  // Um job pode terminar (e devolver o card + religar o workflow) entre dois
  // polls de 3s — sem isto o botão "Executar agentes" ficaria bloqueado por
  // até 3s a mais depois do término real.
  useEffect(() => {
    return subscribe((ev) => {
      switch (ev.type) {
        case 'JOB_STARTED':
        case 'JOB_STALLED':
        case 'JOB_FINISHED':
          void poll()
          break
      }
    })
  }, [poll])

  async function exec(fn: () => Promise<Awaited<ReturnType<typeof client.workflowStart>>>) {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (res.ok) setError(null)
    else setError(errorText(res.error))
    void poll()
  }

  const run = status?.run ?? null
  const running = run?.status === 'running'
  const lastActivity = status?.last_activity_at ? new Date(status.last_activity_at).getTime() : null
  const idleMs = running && lastActivity !== null ? Date.now() - lastActivity : 0
  const idle = idleMs > IDLE_WARN_MS
  const inProgress = status?.in_progress_cards ?? []
  // Payload antigo (sem `jobs`) não deve quebrar — trata como "nenhum job".
  const jobs: readonly JobView[] = status?.jobs ?? []
  const runningJobs = jobs.filter((j) => j.status === 'running')
  const stalledJobs = runningJobs.filter((j) => j.stalled)
  const hasRunningJob = runningJobs.length > 0

  return (
    <div className="agents-bar">
      <span className={`pill${run ? ` wf-${run.status}` : ''}`}>
        {run ? statusLabel(run.status) : 'sem execução'}
      </span>
      {run && status && <span className="pill">{PHASE_LABEL[status.phase]}</span>}
      {inProgress.length > 0 && (
        <span className="pill">{inProgress.length} card(s) em andamento</span>
      )}
      {/*
        Última tool call vista no log — em voo ou já concluída — sempre
        visível, não só enquanto está rodando: é o sinal mais concreto de "o
        que o agente está/esteve fazendo agora", sem precisar abrir detalhes.
        Sobe pra tom de aviso quando uma chamada em voo passa do limiar de
        idle (comando/edição realmente demorado, não só o gap normal de
        1-2min entre cards).
      */}
      {status?.last_tool && (
        <span
          className={`pill${status.last_tool.status !== 'done' && (status.last_tool.status === 'error' || idle) ? ' wf-idle' : ''}`}
          title="Última chamada de ferramenta vista no log do round dev atual"
        >
          {toolStatusIcon(status.last_tool.status)} {status.last_tool.name}
          {status.last_tool.status === 'running' && idle ? ` — executando há ${formatIdle(idleMs)}` : ''}
        </span>
      )}
      {idle && !status?.last_tool && (
        <span
          className="pill wf-idle"
          title="Nenhuma atividade recente no log — pode ser só o modelo pensando entre cards (gaps de 1-2min são normais), ou o harness pode ter travado. Se persistir por bem mais que isso, considere Parar e checar os créditos da API."
        >
          ⏸ sem atividade há {formatIdle(idleMs)}
        </span>
      )}
      {running && run?.stopping_gracefully && (
        <span
          className="pill wf-idle"
          title="Nenhuma rodada nova será iniciada — o dev agent termina o card em andamento sozinho (done/review + log dele mesmo) antes do processo encerrar."
        >
          parando após esta rodada…
        </span>
      )}
      {hasRunningJob && (
        <span
          className="pill"
          title="Comando de longa duração em execução fora da sessão do dev agent — quando terminar, o servidor devolve o card sozinho e religa o workflow. Iniciar agentes agora criaria um orquestrador em cima de trabalho já em curso."
        >
          {runningJobs.length} job(s) em execução — aguardando
        </span>
      )}
      {stalledJobs.map((j) => (
        <span
          key={j.job_id}
          className="pill wf-idle"
          title={`Job sem saída há mais tempo que o esperado (card ${j.card_id}, comando: ${j.command})`}
        >
          ⚠️ job sem saída — {j.card_id}
        </span>
      ))}
      <div className="spacer" />
      <button className="ghost" onClick={() => setOpen(true)}>
        detalhes
      </button>
      {!running && (
        <button
          className="primary"
          disabled={busy || hasRunningJob}
          title={
            hasRunningJob
              ? 'Bloqueado: há job(s) de longa duração em execução nesta sprint — aguarde terminarem (o card volta sozinho e o workflow religa).'
              : undefined
          }
          onClick={() => exec(() => client.workflowStart(sprintId))}
        >
          Executar agentes
        </button>
      )}
      {running && !run?.stopping_gracefully && (
        <button
          disabled={busy}
          title="Não inicia mais rodada — deixa o card em andamento terminar sozinho (com o log que o próprio agente escreve), em vez de matar no meio"
          onClick={() => exec(() => client.workflowRequestStop(sprintId))}
        >
          Parar
        </button>
      )}
      {running && run?.stopping_gracefully && (
        <button
          disabled={busy}
          title="Parada imediata: SIGTERM no workflow e nos agentes que ele criou, interrompendo a rodada no meio — o card em andamento fica claimed sem log de fechamento"
          onClick={() => exec(() => client.workflowStop(sprintId))}
        >
          Parada imediata
        </button>
      )}

      {error && <p className="banner">{error}</p>}

      {open && (
        <AgentsDrawer
          client={client}
          sprintId={sprintId}
          run={run}
          inProgressCards={inProgress}
          busy={busy}
          hasRunningJob={hasRunningJob}
          onClose={() => setOpen(false)}
          onStart={() => exec(() => client.workflowStart(sprintId))}
          onRequestStop={() => exec(() => client.workflowRequestStop(sprintId))}
          onStop={() => exec(() => client.workflowStop(sprintId))}
        />
      )}
    </div>
  )
}

function AgentsDrawer({
  client,
  sprintId,
  run,
  inProgressCards,
  busy,
  hasRunningJob,
  onClose,
  onStart,
  onRequestStop,
  onStop,
}: {
  client: KanbanClient
  sprintId: string
  run: WorkflowRunView | null
  inProgressCards: readonly WorkflowInProgressCard[]
  busy: boolean
  hasRunningJob: boolean
  onClose: () => void
  onStart: () => void
  onRequestStop: () => void
  onStop: () => void
}) {
  const [log, setLog] = useState('')
  const offsetRef = useRef(0)
  const preRef = useRef<HTMLPreElement | null>(null)

  const pollLog = useCallback(async () => {
    const chunk = await client.getWorkflowLog(sprintId, offsetRef.current)
    if (chunk.ok) {
      offsetRef.current = chunk.data.size
      if (chunk.data.data) setLog((prev) => prev + chunk.data.data)
    }
  }, [client, sprintId])

  useEffect(() => {
    offsetRef.current = 0
    setLog('')
    void pollLog()
    const timer = setInterval(() => void pollLog(), LOG_POLL_MS)
    return () => clearInterval(timer)
  }, [pollLog])

  // Log novo → rola para o fim, como um tail -f.
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const running = run?.status === 'running'

  return (
    <Dialog title="Agentes da sprint" onClose={onClose}>
      <div className="form-row">
        {run && <span className={`pill wf-${run.status}`}>{statusLabel(run.status)}</span>}
        {running && run?.stopping_gracefully && (
          <span className="pill wf-idle">parando após esta rodada…</span>
        )}
        <div className="spacer" />
        {!running && (
          <button
            className="primary"
            disabled={busy || hasRunningJob}
            title={
              hasRunningJob
                ? 'Bloqueado: há job(s) de longa duração em execução nesta sprint — aguarde terminarem (o card volta sozinho e o workflow religa).'
                : undefined
            }
            onClick={onStart}
          >
            Executar agentes
          </button>
        )}
        {running && !run?.stopping_gracefully && (
          <button
            disabled={busy}
            title="Não inicia mais rodada — deixa o card em andamento terminar sozinho"
            onClick={onRequestStop}
          >
            Parar
          </button>
        )}
        {running && run?.stopping_gracefully && (
          <button
            disabled={busy}
            title="Parada imediata: interrompe a rodada no meio"
            onClick={onStop}
          >
            Parada imediata
          </button>
        )}
      </div>

      {run && (
        <p className="empty" style={{ padding: 0 }}>
          {run.started_at.slice(0, 19).replace('T', ' ')}
          {run.ended_at ? ` → ${run.ended_at.slice(11, 19)}` : ''}
          {run.exit_code !== null ? ` · exit ${run.exit_code}` : ''}
          {run.pid !== null && running ? ` · pid ${run.pid}` : ''}
        </p>
      )}

      {inProgressCards.length > 0 && (
        <ul className="pick">
          {inProgressCards.map((c) => (
            <li key={c.id}>
              <span className="pick-title">{c.title}</span>
              <span className="mono pick-meta">
                {c.assigned_to ?? 'sem responsável'}
                {c.assigned_role ? ` · ${c.assigned_role}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}

      {log ? (
        <pre ref={preRef} className="workflow-log" aria-label="log do workflow">
          {log}
        </pre>
      ) : (
        <p className="empty">
          {running ? 'aguardando as primeiras linhas do log…' : 'nenhuma execução registrada para esta sprint'}
        </p>
      )}
    </Dialog>
  )
}

function toolStatusIcon(status: WorkflowLastTool['status']): string {
  switch (status) {
    case 'running':
      return '🔧'
    case 'done':
      return '✅'
    case 'error':
      return '⚠️'
  }
}

function formatIdle(ms: number): string {
  const min = Math.floor(ms / 60_000)
  if (min < 1) return `${Math.floor(ms / 1000)}s`
  const sec = Math.floor((ms % 60_000) / 1000)
  return `${min}min${sec > 0 ? ` ${sec}s` : ''}`
}

function statusLabel(status: WorkflowRunView['status']): string {
  switch (status) {
    case 'running':
      return 'executando'
    case 'exited':
      return 'concluído'
    case 'failed':
      return 'falhou'
    case 'stopped':
      return 'parado'
  }
}
