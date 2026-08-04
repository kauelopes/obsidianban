import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { WeeklyDigest } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Tile } from '../metrics/widgets.js'
import { addDays, fmtDay, mondayOf, todayIso } from '../util/time.js'

// timeZone UTC: o instante é montado com Date.UTC, e formatar em fuso local
// jogaria o dia para trás a oeste de Greenwich.
const rangeFmt = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
})

/**
 * Retrospectiva da semana: o que fechou, o que vem, o que travou.
 *
 * Computado, não escrito por agente — o valor aqui é ser um espelho fiel e
 * barato do vault, e prosa gerada custaria uma chamada de LLM por navegação
 * de semana para dizer o que a lista já diz.
 */
export function Review({ client }: { client: KanbanClient }) {
  const [weekStart, setWeekStart] = useState(() => mondayOf(todayIso()))
  const [data, setData] = useState<WeeklyDigest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await client.getDigest({ week_start: weekStart })
    setLoading(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setError(null)
    setData(res.data)
  }, [client, weekStart])

  useEffect(() => {
    void load()
  }, [load])

  const thisWeek = mondayOf(todayIso())
  const isCurrent = weekStart >= thisWeek

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Revisão semanal</h1>
          <div className="detail-ident mono">{rangeLabel(weekStart)}</div>
        </div>

        {error && <p className="banner">{error}</p>}

        <div className="horizon-nav">
          <button
            className="ghost"
            aria-label="Semana anterior"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
          >
            ‹ semana anterior
          </button>
          {!isCurrent && (
            <button className="ghost" onClick={() => setWeekStart(thisWeek)}>
              esta semana
            </button>
          )}
          <button
            className="ghost"
            aria-label="Próxima semana"
            disabled={isCurrent}
            onClick={() => setWeekStart((w) => addDays(w, 7))}
          >
            próxima semana ›
          </button>
        </div>

        {loading && !data ? (
          <p className="empty-lg">carregando a semana…</p>
        ) : data ? (
          <>
            <div className="tiles">
              <Tile label="sprints fechadas" value={String(data.sprints_closed.length)} />
              <Tile label="cards concluídos" value={String(data.cards_done.length)} />
              <Tile label="metas concluídas" value={String(data.goals_done.length)} />
              <Tile
                label="horas estimadas"
                value={data.hours_estimate_available ? `≈ ${data.hours_estimate.toLocaleString('pt-BR')} h` : '—'}
                muted={!data.hours_estimate_available}
              />
              <Tile
                label="custo medido"
                value={
                  data.activity.summary.total_cost_usd > 0
                    ? `US$ ${data.activity.summary.total_cost_usd.toFixed(2)}`
                    : 'não reportado'
                }
                muted={data.activity.summary.total_cost_usd === 0}
              />
            </div>

            <Section title="Sprints fechadas" empty="Nenhuma sprint fechou nesta semana.">
              {data.sprints_closed.map((s) => (
                <li key={`${s.project}/${s.sprint_id}`}>
                  <Link to={`/board/${s.project}`}>
                    <strong>{s.name}</strong>
                    <span className="where mono">{s.project}</span>
                  </Link>
                  {s.goal && <p className="review-note">{s.goal}</p>}
                </li>
              ))}
            </Section>

            <Section title="Cards concluídos" empty="Nenhum card entrou em done nesta semana.">
              {data.cards_done.map((c) => (
                <li key={`${c.card_id}/${c.ts}`}>
                  <Link to={`/card/${c.card_id}`}>
                    <strong>{c.title}</strong>
                    <span className="where mono">{c.project}</span>
                  </Link>
                </li>
              ))}
            </Section>

            <Section title="Metas concluídas" empty="Nenhuma meta foi concluída nesta semana.">
              {data.goals_done.map((g) => (
                <li key={`${g.project}/${g.goal_id}`}>
                  <Link to={`/board/${g.project}`}>
                    <strong>{g.title}</strong>
                    <span className="where mono">{g.project}</span>
                  </Link>
                </li>
              ))}
            </Section>

            <Section title="Metas da semana que vem" empty="Nenhuma meta vence na semana seguinte.">
              {data.goals_upcoming.map((g) => (
                <li key={`${g.project}/${g.goal_id}`}>
                  <Link to="/horizonte">
                    <strong>{g.title}</strong>
                    <span className="where mono">{g.project}</span>
                    <span className="age mono">{fmtDay(g.target_date)}</span>
                  </Link>
                </li>
              ))}
            </Section>

            <Section
              title="Escalações paradas"
              empty="Nada esperando resposta há mais de alguns dias."
            >
              {data.stalled_reviews.map((s) => (
                <li key={s.card_id} className="goal-overdue">
                  <Link to={`/card/${s.card_id}`}>
                    <strong>{s.title}</strong>
                    <span className="where mono">{s.project}</span>
                    <span className="age mono">
                      há {s.days_stalled} dia{s.days_stalled === 1 ? '' : 's'}
                    </span>
                  </Link>
                </li>
              ))}
            </Section>

            <p className="note">
              Concluídos vêm do log de auditoria: um card criado já em done, ou uma meta fechada
              editando o <code>_meta.json</code> à mão, não aparecem aqui.
              {!data.hours_estimate_available &&
                ' A estimativa de horas só existe para a semana corrente.'}
              {data.audit_truncated && ' O log foi lido só até o limite — pode faltar coisa.'}
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}

function Section({
  title,
  empty,
  children,
}: {
  title: string
  empty: string
  children: React.ReactNode[]
}) {
  return (
    <section className="chart">
      <p className="label">{title}</p>
      {children.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ul className="pending">{children}</ul>
      )}
    </section>
  )
}

/** "6 de julho — 12 de julho" */
function rangeLabel(weekStart: string): string {
  const end = addDays(weekStart, 6)
  const at = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number)
    return rangeFmt.format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)))
  }
  return `${at(weekStart)} — ${at(end)}`
}
