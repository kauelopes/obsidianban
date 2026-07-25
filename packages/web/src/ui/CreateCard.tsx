import { useState } from 'react'
import type { Sprint } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Dialog } from './Dialog.js'
import { ZoneEditor } from '../card/ZoneEditor.js'

const TYPES = ['feature', 'bug', 'task', 'chore']
const PRIORITIES = ['low', 'medium', 'high', 'critical']

export function CreateCard({
  client,
  project,
  sprints,
  onClose,
  onCreated,
}: {
  client: KanbanClient
  project: string
  sprints: readonly Sprint[]
  onClose: () => void
  onCreated: () => void
}) {
  // A closed sprint refuses new cards server-side, so it is not offered.
  const open = sprints.filter((s) => s.status !== 'closed')
  const [title, setTitle] = useState('')
  const [type, setType] = useState('task')
  const [priority, setPriority] = useState('medium')
  const [sprintId, setSprintId] = useState(open.find((s) => s.status === 'active')?.id ?? open[0]?.id ?? '')
  const [spec, setSpec] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    const res = await client.createCard({
      project,
      title: title.trim(),
      type,
      priority,
      sprint_id: sprintId,
      // Written straight into # Spec so the card starts in the three-zone
      // shape instead of as an unlabelled blob.
      body: spec.trim() ? `# Spec\n\n${spec.trim()}` : '',
    })
    setBusy(false)
    if (res.ok) {
      onCreated()
      onClose()
    } else {
      setError(errorText(res.error))
    }
  }

  const canCreate = title.trim().length > 0 && sprintId !== '' && !busy

  return (
    <Dialog
      title={`Novo card em ${project}`}
      onClose={onClose}
      footer={
        <>
          <button className="primary" disabled={!canCreate} onClick={create}>
            {busy ? 'criando…' : 'Criar'}
          </button>
          <button onClick={onClose}>Cancelar</button>
        </>
      }
    >
      {error && <p className="banner">{error}</p>}
      {open.length === 0 && (
        <p className="banner">
          Este projeto não tem sprint aberta. Crie uma sprint antes — todo card
          nasce dentro de uma.
        </p>
      )}

      <div className="form">
        <label>
          <span>Título</span>
          <input
            autoFocus
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <div className="form-row">
          <label>
            <span>Tipo</span>
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <label>
            <span>Prioridade</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label>
            <span>Sprint</span>
            <select value={sprintId} onChange={(e) => setSprintId(e.target.value)}>
              {open.map((s) => (
                <option key={s.id} value={s.id}>{s.name} — {s.status}</option>
              ))}
            </select>
          </label>
        </div>

        <label>
          <span>Spec</span>
          <ZoneEditor
            value={spec}
            onChange={setSpec}
            rows={10}
            placeholder="Contexto, critérios de aceite, restrições."
          />
        </label>
      </div>
    </Dialog>
  )
}
