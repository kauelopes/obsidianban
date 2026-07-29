import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowRunView } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'

const POLL_MS = 2500
// Gaps entre cards de um round de 3 chegam a ~2m30s nesta sprint só pelo
// tempo de "pensar" do modelo (contexto crescendo a cada card, turnos de API)
// — ver docs/for-agents/sprint-workflow.md. Um limiar abaixo disso dispara em
// toda rodada normal e o alerta vira ruído. 5min dá folga sobre o pior caso
// observado sem deixar um travamento real passar despercebido por muito tempo.
const IDLE_WARN_MS = 5 * 60 * 1000

/**
 * Execução do sprint workflow para uma sprint ativa: disparar/parar os
 * agentes e acompanhar o log ao vivo. O log é lido incrementalmente pela rota
 * GET /workflow/log (offset = size da resposta anterior), com polling
 * enquanto o painel está aberto — o SSE só anuncia começo/fim, não as linhas.
 */
export function WorkflowPanel({
  client,
  sprintId,
  sprintActive,
}: {
  client: KanbanClient
  sprintId: string
  /** Só uma sprint ativa pode disparar o workflow — sem ela, painel é leitura. */
  sprintActive: boolean
}) {
  const [run, setRun] = useState<WorkflowRunView | null>(null)
  const [log, setLog] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Offset em ref: o intervalo de polling não deve reiniciar a cada chunk lido.
  const offsetRef = useRef(0)
  const preRef = useRef<HTMLPreElement | null>(null)
  // Última vez que o log CRESCEU (não a última vez que pollamos) — é o sinal
  // de atividade real do harness. now/lastGrowthAt em estado (não ref) porque
  // o texto "há Xm" precisa re-renderizar a cada tick de poll, mesmo sem
  // nenhuma linha nova chegar.
  const [lastGrowthAt, setLastGrowthAt] = useState<number | null>(null)
  const [now, setNow] = useState<number | null>(null)

  const poll = useCallback(async () => {
    const [status, chunk] = await Promise.all([
      client.workflowStatus(sprintId),
      client.getWorkflowLog(sprintId, offsetRef.current),
    ])
    if (status.ok) {
      setRun(status.data.run)
      setError(null)
    } else if (status.error.kind === 'server' || status.error.kind === 'offline') {
      // Engolir isto deixaria o painel mudo num servidor sem as tools de
      // workflow (processo antigo) — o erro é a informação mais útil que temos.
      setError(
        status.error.kind === 'server' && status.error.status === 501
          ? 'O servidor em execução não tem as tools de workflow — reinicie o servidor kanban para carregar o código novo.'
          : errorText(status.error),
      )
    }
    if (chunk.ok) {
      const grew = chunk.data.data.length > 0
      offsetRef.current = chunk.data.size
      if (chunk.data.data) setLog((prev) => prev + chunk.data.data)
      if (!status.ok && chunk.data.run) setRun(chunk.data.run)
      setNow(Date.now())
      if (grew) setLastGrowthAt(Date.now())
    }
  }, [client, sprintId])

  useEffect(() => {
    offsetRef.current = 0
    setLog('')
    setRun(null)
    setLastGrowthAt(null)
    setNow(null)
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => clearInterval(timer)
  }, [poll])

  // Log novo → rola para o fim, como um tail -f.
  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  // O painel abre abaixo da tabela de sprints — sem isto, num diálogo já
  // rolado ele nasce fora da viewport e o clique parece não fazer nada.
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [])

  const running = run?.status === 'running'
  const idleMs = running && now !== null && lastGrowthAt !== null ? now - lastGrowthAt : 0
  const idle = idleMs > IDLE_WARN_MS

  async function exec(fn: () => Promise<Awaited<ReturnType<typeof client.workflowStart>>>) {
    setBusy(true)
    const res = await fn()
    setBusy(false)
    if (res.ok) setError(null)
    else setError(errorText(res.error))
    void poll()
  }

  return (
    <div className="workflow-panel" ref={rootRef}>
      <div className="form-row">
        <span className="label" style={{ margin: 0 }}>
          Agentes da sprint
        </span>
        {run && <span className={`pill wf-${run.status}`}>{statusLabel(run.status)}</span>}
        {idle && (
          <span
            className="pill wf-idle"
            title="Nenhuma linha nova no log — pode ser só o modelo pensando entre cards (gaps de 1-2min são normais), ou o harness pode ter travado. Se persistir por bem mais que isso, considere Parar e checar os créditos da API."
          >
            ⏸ sem atividade há {formatIdle(idleMs)}
          </span>
        )}
        <div className="spacer" />
        {!running && (
          <button
            className="primary"
            disabled={busy || !sprintActive}
            title={sprintActive ? undefined : 'a sprint precisa estar ativa'}
            onClick={() => exec(() => client.workflowStart(sprintId))}
          >
            Executar agentes
          </button>
        )}
        {running && (
          <button
            disabled={busy}
            title="SIGTERM no workflow e nos agentes que ele criou"
            onClick={() => exec(() => client.workflowStop(sprintId))}
          >
            Parar
          </button>
        )}
      </div>

      {error && <p className="banner">{error}</p>}

      {run && (
        <p className="empty" style={{ padding: 0 }}>
          {run.started_at.slice(0, 19).replace('T', ' ')}
          {run.ended_at ? ` → ${run.ended_at.slice(11, 19)}` : ''}
          {run.exit_code !== null ? ` · exit ${run.exit_code}` : ''}
          {run.pid !== null && running ? ` · pid ${run.pid}` : ''}
        </p>
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
    </div>
  )
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
