import { useState } from 'react'
import type { Sprint } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Dialog } from './Dialog.js'

export function SprintPanel({
  client,
  project,
  sprints,
  onClose,
  onChanged,
}: {
  client: KanbanClient
  project: string
  sprints: readonly Sprint[]
  onClose: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hasActive = sprints.some((s) => s.status === 'active')

  async function run(fn: () => Promise<{ ok: boolean; error?: unknown }>) {
    setBusy(true)
    const res = (await fn()) as Awaited<ReturnType<typeof client.startSprint>>
    setBusy(false)
    if (res.ok) {
      setError(null)
      onChanged()
    } else {
      setError(errorText(res.error))
    }
  }

  return (
    <Dialog title={`Sprints — ${project}`} onClose={onClose}>
      {error && <p className="banner">{error}</p>}

      <table className="sprints">
        <tbody>
          {sprints.length === 0 && (
            <tr><td className="empty">nenhuma sprint ainda</td></tr>
          )}
          {sprints.map((s) => (
            <tr key={s.id}>
              <td>
                <strong>{s.name}</strong>
                {s.goal && <><br /><span className="empty">{s.goal}</span></>}
              </td>
              <td><span className={`pill ${s.status}`}>{s.status}</span></td>
              <td>
                {s.status === 'planning' && (
                  <button
                    disabled={busy || hasActive}
                    title={hasActive ? 'já existe uma sprint ativa' : undefined}
                    onClick={() => run(() => client.startSprint({ sprint_id: s.id }))}
                  >
                    iniciar
                  </button>
                )}
                {s.status === 'active' && (
                  <button
                    disabled={busy}
                    onClick={() => run(() => client.closeSprint({ sprint_id: s.id, rollover_to: null }))}
                  >
                    fechar
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="form" style={{ marginTop: 16 }}>
        <label>
          <span>Nova sprint</span>
          <input
            value={name}
            maxLength={80}
            placeholder="nome"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span>Objetivo (opcional)</span>
          <input
            value={goal}
            maxLength={1000}
            onChange={(e) => setGoal(e.target.value)}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !name.trim()}
          onClick={() =>
            run(async () => {
              const r = await client.createSprint({
                project,
                name: name.trim(),
                ...(goal.trim() ? { goal: goal.trim() } : {}),
              })
              if (r.ok) {
                setName('')
                setGoal('')
              }
              return r
            })
          }
        >
          Criar sprint
        </button>
      </div>
    </Dialog>
  )
}
