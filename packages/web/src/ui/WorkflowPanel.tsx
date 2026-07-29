import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowRunView } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'

const POLL_MS = 2500

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
      offsetRef.current = chunk.data.size
      if (chunk.data.data) setLog((prev) => prev + chunk.data.data)
      if (!status.ok && chunk.data.run) setRun(chunk.data.run)
    }
  }, [client, sprintId])

  useEffect(() => {
    offsetRef.current = 0
    setLog('')
    setRun(null)
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
