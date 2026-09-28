import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import type { Goal } from '@obsidiankan/types'
import { errorText, type McpResult } from '../api/result.js'
import type { ProjectOutletContext } from './ProjectLayout.js'

/**
 * Metas de médio prazo do projeto — aba própria do workspace (antes vivia
 * dentro do modal de ajustes, aba "Planejamento"). A home só EXIBE; criar,
 * concluir, replanejar prazo e remover acontecem aqui. O estado local é a
 * resposta das tools — o resto da UI atualiza pelo SSE de
 * PROJECT_GOALS_UPDATED via onChanged.
 */
export function GoalsTab() {
  const { client, project, board } = useOutletContext<ProjectOutletContext>()
  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Metas</h1>
          <div className="detail-ident">
            <span className="mono">{project}</span>
          </div>
        </div>
        <GoalsSection client={client} project={project} onChanged={board.reload} />
      </div>
    </div>
  )
}

function GoalsSection({
  client,
  project,
  onChanged,
}: {
  client: ProjectOutletContext['client']
  project: string
  onChanged: () => void
}) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void client.listProjects({ include_archived: true }).then((res) => {
      if (res.ok) {
        setGoals(res.data.projects.find((p) => p.project === project)?.goals ?? [])
      }
    })
  }, [client, project])

  async function mutate<T>(fn: () => Promise<McpResult<T>>): Promise<boolean> {
    setBusy(true)
    setError(null)
    const res = await fn()
    setBusy(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return false
    }
    onChanged()
    return true
  }

  async function addGoal() {
    const ok = await mutate(() =>
      client.setGoal({ project, title: title.trim(), target_date: date || null }),
    )
    if (ok) {
      setTitle('')
      setDate('')
      await reload()
    }
  }

  async function patch(id: string, changes: { status?: Goal['status']; target_date?: string | null }) {
    if (await mutate(() => client.setGoal({ project, id, ...changes }))) await reload()
  }

  async function remove(id: string) {
    if (await mutate(() => client.deleteGoal({ project, id }))) await reload()
  }

  async function reload() {
    const res = await client.listProjects({ include_archived: true })
    if (res.ok) setGoals(res.data.projects.find((p) => p.project === project)?.goals ?? [])
  }

  return (
    <div className="form" style={{ marginTop: 'var(--s-6)' }}>
      {error && <p className="banner">{error}</p>}
      <p className="label">Metas do projeto</p>
      {goals.length === 0 && <p className="field-help">Nenhuma meta ainda.</p>}
      {goals.map((g) => (
        <div className="form-row goal-row" key={g.id}>
          <span className={`goal-title${g.status !== 'open' ? ' muted' : ''}`} title={g.title}>
            {g.status === 'done' ? '✓ ' : g.status === 'dropped' ? '× ' : ''}
            {g.title}
          </span>
          <div className="goal-actions">
            <input
              type="date"
              aria-label={`Prazo de ${g.title}`}
              value={g.target_date ?? ''}
              disabled={busy || g.status !== 'open'}
              onChange={(e) => void patch(g.id, { target_date: e.target.value || null })}
            />
            {g.status === 'open' ? (
              <button disabled={busy} onClick={() => void patch(g.id, { status: 'done' })}>
                Concluir
              </button>
            ) : (
              <button disabled={busy} onClick={() => void patch(g.id, { status: 'open' })}>
                Reabrir
              </button>
            )}
            <button className="danger" disabled={busy} onClick={() => void remove(g.id)}>
              Remover
            </button>
          </div>
        </div>
      ))}
      <label>
        <span>Nova meta</span>
        <div className="form-row">
          <input
            value={title}
            placeholder="ex. Lançar a v1 pública"
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            type="date"
            aria-label="Prazo da nova meta"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button className="primary" disabled={busy || !title.trim()} onClick={() => void addGoal()}>
            Adicionar meta
          </button>
        </div>
        <span className="field-help">
          Metas vivem no _meta.json do projeto — dá para editá-las também pelo Obsidian, e os
          agentes as enxergam via kanban_list_projects.
        </span>
      </label>
    </div>
  )
}
