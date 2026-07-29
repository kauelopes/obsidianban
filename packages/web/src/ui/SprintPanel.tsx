import { useCallback, useEffect, useState } from 'react'
import type { CardSummary, Epic, GetSprintResult, Sprint } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Dialog } from './Dialog.js'
import { WorkflowPanel } from './WorkflowPanel.js'

export function SprintPanel({
  client,
  project,
  sprints,
  cards,
  onClose,
  onChanged,
}: {
  client: KanbanClient
  project: string
  sprints: readonly Sprint[]
  /** Cards do projeto, para poder anexar os que estão fora desta sprint. */
  cards: readonly CardSummary[]
  onClose: () => void
  onChanged: () => void
}) {
  const [name, setName] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [detail, setDetail] = useState<GetSprintResult | null>(null)
  const [moveTo, setMoveTo] = useState('')
  // Épico de cada sprint (se houver) — só para o badge ao lado do nome.
  const [epicOf, setEpicOf] = useState<Record<string, string>>({})
  // Sprint cujo painel de execução de agentes está aberto (uma por vez).
  const [wfId, setWfId] = useState<string | null>(null)

  useEffect(() => {
    void client.listEpics(project).then((res) => {
      if (!res.ok) return
      const map: Record<string, string> = {}
      for (const e of res.data.epics as Epic[]) {
        for (const sid of e.sprint_ids) map[sid] = e.name
      }
      setEpicOf(map)
    })
  }, [client, project])

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

  // Os agregados (contagem por status e soma de tokens) só existem em
  // kanban_get_sprint — list_sprints não os devolve.
  const loadDetail = useCallback(
    async (sprintId: string) => {
      const res = await client.getSprint({ sprint_id: sprintId })
      if (res.ok) setDetail(res.data)
      else {
        setDetail(null)
        setError(errorText(res.error))
      }
    },
    [client],
  )

  useEffect(() => {
    if (openId) void loadDetail(openId)
    else setDetail(null)
  }, [openId, loadDetail])

  return (
    <Dialog title={`Sprints — ${project}`} onClose={onClose}>
      {error && <p className="banner">{error}</p>}

      <table className="table">
        <tbody>
          {sprints.length === 0 && (
            <tr>
              <td className="empty">nenhuma sprint ainda</td>
            </tr>
          )}
          {sprints.map((s) => (
            <tr key={s.id}>
              <td>
                <button
                  className="ghost"
                  style={{ padding: 0, textAlign: 'left' }}
                  onClick={() => setOpenId((cur) => (cur === s.id ? null : s.id))}
                >
                  <strong>{s.name}</strong>
                </button>
                {epicOf[s.id] && <span className="pill">{epicOf[s.id]}</span>}
                {/* goal vem como string vazia, não null, nas sprints reais */}
                {s.goal ? (
                  <>
                    <br />
                    <span className="empty" style={{ padding: 0 }}>
                      {s.goal}
                    </span>
                  </>
                ) : null}
                {openId === s.id && detail && <SprintDetail d={detail} />}
              </td>
              <td>
                <span className={`pill ${s.status}`}>{s.status}</span>
              </td>
              <td className="actions">
                {s.status === 'planning' && (
                  <button
                    disabled={busy || hasActive}
                    title={hasActive ? 'já existe uma sprint ativa' : undefined}
                    onClick={() => run(() => client.startSprint({ sprint_id: s.id }))}
                  >
                    iniciar
                  </button>
                )}
                {(s.status === 'active' || s.status === 'closed') && (
                  <button
                    className={wfId === s.id ? undefined : 'ghost'}
                    title="Executar e acompanhar os agentes desta sprint"
                    onClick={() => setWfId((cur) => (cur === s.id ? null : s.id))}
                  >
                    agentes
                  </button>
                )}
                {s.status === 'active' && (
                  <button
                    disabled={busy}
                    // "fechar" lia-se como fechar o modal; isto encerra a
                    // sprint e arquiva os done — merece nome de ciclo de vida.
                    title="Encerra a sprint e arquiva os cards em done"
                    onClick={() =>
                      run(() => client.closeSprint({ sprint_id: s.id, rollover_to: null }))
                    }
                  >
                    encerrar sprint
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {wfId && (
        <WorkflowPanel
          client={client}
          sprintId={wfId}
          sprintActive={sprints.some((s) => s.id === wfId && s.status === 'active')}
        />
      )}

      {/*
        Anexar cards a uma sprint também não tinha via de UI. Só aparecem os que
        ainda não pertencem a esta sprint, senão a lista mente sobre o que a ação
        faz.
      */}
      {openId && (
        <AddCards
          cards={cards.filter((c) => c.sprint_id !== openId)}
          busy={busy}
          onAdd={(ids, moveToTodo) =>
            run(async () => {
              const r = await client.addToSprint({
                sprint_id: openId,
                card_ids: ids,
                ...(moveToTodo ? { move_to_todo: true } : {}),
              })
              if (r.ok && r.data.failed.length > 0) {
                setError(
                  `${r.data.updated.length} anexados, ${r.data.failed.length} falharam: ` +
                    r.data.failed.map((f) => `${f.card_id} (${f.reason})`).join(', '),
                )
              }
              if (r.ok) void loadDetail(openId)
              return r
            })
          }
        />
      )}

      {/*
        Mover cards entre sprints não tinha nenhuma via de UI: era curl ou
        editar o sprint_id card por card no formulário.
      */}
      {openId && detail && detail.cards.length > 0 && (
        <div className="form" style={{ marginTop: 'var(--s-6)' }}>
          <label>
            <span>Mover os {detail.cards.length} cards desta sprint para</span>
            <div className="form-row">
              <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
                <option value="">escolha a sprint destino…</option>
                {sprints
                  .filter((s) => s.id !== openId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} — {s.status}
                    </option>
                  ))}
              </select>
              <button
                disabled={busy || !moveTo}
                onClick={() =>
                  run(async () => {
                    const r = await client.moveBetweenSprints({
                      sprint_id: openId,
                      target_sprint_id: moveTo,
                      card_ids: detail.cards.map((c) => c.id),
                    })
                    // Sucesso parcial devolve 200 com failed[] preenchido, então
                    // olhar só o status esconderia cards que não foram.
                    if (r.ok && r.data.failed.length > 0) {
                      setError(
                        `${r.data.updated.length} movidos, ${r.data.failed.length} falharam: ` +
                          r.data.failed.map((f) => `${f.card_id} (${f.reason})`).join(', '),
                      )
                    }
                    if (r.ok) {
                      setMoveTo('')
                      void loadDetail(openId)
                    }
                    return r
                  })
                }
              >
                Mover
              </button>
            </div>
          </label>
        </div>
      )}

      <div className="form" style={{ marginTop: 'var(--s-6)' }}>
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
          <input value={goal} maxLength={1000} onChange={(e) => setGoal(e.target.value)} />
        </label>
        {/* Ação primária à direita, como no footer dos outros dialogs. */}
        <div className="form-row">
          <div className="spacer" />
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
      </div>
    </Dialog>
  )
}

function AddCards({
  cards,
  busy,
  onAdd,
}: {
  cards: readonly CardSummary[]
  busy: boolean
  onAdd: (ids: string[], moveToTodo: boolean) => void
}) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [moveToTodo, setMoveToTodo] = useState(false)

  if (cards.length === 0) {
    return (
      <p className="empty" style={{ marginTop: 'var(--s-6)' }}>
        todos os cards do projeto já estão nesta sprint
      </p>
    )
  }

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="form" style={{ marginTop: 'var(--s-6)' }}>
      <span className="label">Anexar cards a esta sprint</span>
      <ul className="pick">
        {cards.map((c) => (
          <li key={c.id}>
            <label>
              <input
                type="checkbox"
                checked={picked.has(c.id)}
                onChange={() => toggle(c.id)}
              />
              <span className="pick-title">{c.title}</span>
              <span className="mono pick-meta">
                {c.status.replace(/_/g, ' ')}
                {c.sprint_id ? ' · já em outra sprint' : ' · sem sprint'}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <label className="toggle">
        <input
          type="checkbox"
          checked={moveToTodo}
          onChange={(e) => setMoveToTodo(e.target.checked)}
        />
        mover para todo ao anexar
      </label>
      <div className="form-row">
        <div className="spacer" />
        <button
          className="primary"
          disabled={busy || picked.size === 0}
          onClick={() => {
            onAdd([...picked], moveToTodo)
            setPicked(new Set())
          }}
        >
          Anexar {picked.size > 0 ? `${picked.size} card(s)` : ''}
        </button>
      </div>
    </div>
  )
}

function SprintDetail({ d }: { d: GetSprintResult }) {
  const a = d.aggregates
  const tokens = a.total_input_tokens + a.total_output_tokens
  return (
    <dl className="managed" style={{ marginTop: 'var(--s-4)' }}>
      <div style={{ display: 'contents' }}>
        <dt>cards</dt>
        <dd>
          {a.cards_total} — {a.cards_done} done · {a.cards_in_progress} in progress ·{' '}
          {a.cards_todo} todo · {a.cards_other} outros
        </dd>
        <dt>tokens</dt>
        {/*
          Zero aqui não é um bug de leitura: os agentes não reportam tokens (o
          prompt do dev manda omitir), então dizer "não reportado" é honesto e
          "0" seria uma medição inventada.
        */}
        <dd>
          {tokens > 0
            ? `${a.total_input_tokens.toLocaleString('pt-BR')} in · ${a.total_output_tokens.toLocaleString('pt-BR')} out`
            : 'não reportado'}
        </dd>
      </div>
    </dl>
  )
}
