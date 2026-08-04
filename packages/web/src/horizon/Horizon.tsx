import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Goal } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { goalUrgency } from '../home/goal-urgency.js'
import { fmtDay, todayIso } from '../util/time.js'
import {
  buildMonthGrid,
  dayLabel,
  monthLabel,
  shiftMonth,
  WEEKDAY_LABELS,
  type CalendarCell,
} from './calendar.js'
import {
  BUCKET_LABEL,
  datedGoals,
  groupGoalsByHorizon,
  type GoalWithProject,
} from './horizon.js'

interface ProjectGoals {
  project: string
  goals: Goal[]
}

/** Quantas metas cabem escritas numa célula antes de virar contagem. */
const CELL_PREVIEW = 2

/**
 * Metas de todos os projetos em dois recortes do mesmo dado: a lista responde
 * "o que vem primeiro", o calendário responde "como o mês está distribuído".
 * Um projeto por vez já é o board — aqui o valor é justamente atravessar.
 */
export function Horizon({ client }: { client: KanbanClient }) {
  const [projects, setProjects] = useState<ProjectGoals[]>([])
  // Token de dev/pm não enxerga kanban_list_projects (manager-only). Sem lista
  // não há visão cross-project possível — e diferente de Files, não adianta
  // digitar um nome: a página inteira é sobre atravessar projetos.
  const [unavailable, setUnavailable] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const today = todayIso()
  const [cursor, setCursor] = useState(() => {
    const [y, m] = today.split('-').map(Number)
    return { year: y ?? 1970, month: (m ?? 1) - 1 }
  })
  const [dayFilter, setDayFilter] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await client.listProjects()
    setLoading(false)
    if (!res.ok) {
      setUnavailable(true)
      return
    }
    setUnavailable(false)
    // Arquivar é pedir para sair da supervisão — vale para as metas também.
    setProjects(
      res.data.projects
        .filter((p) => !p.archived)
        .map((p) => ({ project: p.project, goals: p.goals ?? [] })),
    )
  }, [client])

  useEffect(() => {
    void load()
  }, [load])

  const groups = useMemo(() => groupGoalsByHorizon(projects, today), [projects, today])
  const dated = useMemo(() => datedGoals(projects), [projects])
  const grid = useMemo(
    () => buildMonthGrid(cursor.year, cursor.month, dated, today),
    [cursor, dated, today],
  )

  const complete = useCallback(
    async (item: GoalWithProject) => {
      const res = await client.setGoal({
        project: item.project,
        id: item.goal.id,
        status: 'done',
      })
      if (!res.ok) {
        setError(errorText(res.error))
        return
      }
      setError(null)
      await load()
    },
    [client, load],
  )

  const setDate = useCallback(
    async (item: GoalWithProject, targetDate: string) => {
      const res = await client.setGoal({
        project: item.project,
        id: item.goal.id,
        target_date: targetDate,
      })
      if (!res.ok) {
        setError(errorText(res.error))
        return
      }
      setError(null)
      await load()
    },
    [client, load],
  )

  const visible = dayFilter
    ? groups
        .map((g) => ({ ...g, items: g.items.filter((i) => i.goal.target_date === dayFilter) }))
        .filter((g) => g.items.length > 0)
    : groups

  const totalOpen = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Horizonte</h1>
          <div className="detail-ident mono">
            {totalOpen > 0 && `${totalOpen} meta${totalOpen === 1 ? '' : 's'} aberta${totalOpen === 1 ? '' : 's'}`}
          </div>
        </div>

        {error && <p className="banner">{error}</p>}

        {unavailable ? (
          <p className="empty-lg">
            A visão cross-project de metas precisa de um token de manager. Com token de dev ou PM,
            as metas aparecem no board de cada projeto.
          </p>
        ) : loading ? (
          <p className="empty-lg">carregando metas…</p>
        ) : totalOpen === 0 ? (
          <p className="empty-lg">
            Nenhuma meta aberta. Metas são definidas no painel de cada projeto, no board.
          </p>
        ) : (
          <div className="home-grid">
            <aside className="home-side">
              {dayFilter && (
                <button className="ghost horizon-chip" onClick={() => setDayFilter(null)}>
                  {dayLabel(dayFilter)} ✕
                </button>
              )}
              {visible.length === 0 ? (
                <p className="empty">Nenhuma meta neste dia.</p>
              ) : (
                visible.map((g) => (
                  <div key={g.bucket} className="horizon-group">
                    <p className="label">{BUCKET_LABEL[g.bucket]}</p>
                    <ul className="pending horizon-list">
                      {g.items.map((item) => (
                        <GoalRow
                          key={`${item.project}/${item.goal.id}`}
                          item={item}
                          today={today}
                          onComplete={complete}
                          onSetDate={setDate}
                        />
                      ))}
                    </ul>
                  </div>
                ))
              )}
            </aside>

            <main className="home-main">
              <div className="horizon-nav">
                <button
                  className="ghost"
                  aria-label="Mês anterior"
                  onClick={() => setCursor((c) => shiftMonth(c.year, c.month, -1))}
                >
                  ‹
                </button>
                <span className="horizon-month">{monthLabel(cursor.year, cursor.month)}</span>
                <button
                  className="ghost"
                  aria-label="Próximo mês"
                  onClick={() => setCursor((c) => shiftMonth(c.year, c.month, 1))}
                >
                  ›
                </button>
              </div>
              <div className="horizon-calendar">
                {WEEKDAY_LABELS.map((w) => (
                  <div key={w} className="horizon-weekday mono">
                    {w}
                  </div>
                ))}
                {grid.map((cell) => (
                  <DayCell
                    key={cell.date}
                    cell={cell}
                    today={today}
                    selected={cell.date === dayFilter}
                    onSelect={() => setDayFilter((d) => (d === cell.date ? null : cell.date))}
                  />
                ))}
              </div>
            </main>
          </div>
        )}
      </div>
    </div>
  )
}

function GoalRow({
  item,
  today,
  onComplete,
  onSetDate,
}: {
  item: GoalWithProject
  today: string
  onComplete: (item: GoalWithProject) => Promise<void>
  onSetDate: (item: GoalWithProject, targetDate: string) => Promise<void>
}) {
  const urgency = goalUrgency(item.goal, today)
  // Uma meta sem prazo não é um estado final — é uma decisão adiada. O botão
  // troca por um seletor de data ali mesmo, sem tirar o olho da lista.
  const [picking, setPicking] = useState(false)
  return (
    // O title= fica no li, não no span do título: no span ele viraria o nome
    // acessível da meta, e um leitor de tela leria a nota no lugar do título.
    <li
      className={urgency === 'ok' ? 'horizon-item' : `horizon-item goal-${urgency}`}
      title={item.goal.notes}
    >
      <div className="horizon-item-main">
        <span className="horizon-title">{item.goal.title}</span>
        <Link className="horizon-project mono" to={`/board/${item.project}`}>
          {item.project}
        </Link>
      </div>
      <div className="horizon-item-side">
        {item.goal.target_date ? (
          <span className="mono goal-date">{fmtDay(item.goal.target_date)}</span>
        ) : picking ? (
          <input
            type="date"
            aria-label={`Prazo de ${item.goal.title}`}
            min={today}
            autoFocus
            onChange={(e) => {
              if (e.target.value) void onSetDate(item, e.target.value)
            }}
            onBlur={() => setPicking(false)}
          />
        ) : (
          <button className="ghost" onClick={() => setPicking(true)}>
            definir prazo
          </button>
        )}
        <button className="ghost" onClick={() => void onComplete(item)}>
          concluir
        </button>
      </div>
    </li>
  )
}

function DayCell({
  cell,
  today,
  selected,
  onSelect,
}: {
  cell: CalendarCell
  today: string
  selected: boolean
  onSelect: () => void
}) {
  const worst = cell.items.some((i) => goalUrgency(i.goal, today) === 'overdue')
    ? 'overdue'
    : cell.items.length > 0
      ? 'due'
      : null
  const classes = [
    'horizon-cell',
    cell.inMonth ? '' : 'out-month',
    cell.isToday ? 'today' : '',
    cell.items.length > 0 ? 'has-goals' : '',
    worst === 'overdue' ? 'has-overdue' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const day = Number(cell.date.slice(8))
  const extra = cell.items.length - CELL_PREVIEW

  return (
    <div
      className={classes}
      onClick={cell.items.length > 0 ? onSelect : undefined}
      title={cell.items.map((i) => `${i.goal.title} (${i.project})`).join('\n')}
    >
      <span className="horizon-day mono">{day}</span>
      {cell.items.slice(0, CELL_PREVIEW).map((i) => (
        <span key={`${i.project}/${i.goal.id}`} className="horizon-dot">
          {i.goal.title}
        </span>
      ))}
      {extra > 0 && <span className="horizon-more mono">+{extra}</span>}
    </div>
  )
}
