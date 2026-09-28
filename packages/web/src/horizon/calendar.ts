import { addDays, mondayOf } from '../util/time.js'
import type { GoalWithProject } from './horizon.js'

/**
 * Grade mensal montada na mão: uma lib de calendário traria um sistema de
 * design inteiro junto, para 42 células que são pura aritmética de data.
 */

export interface CalendarCell {
  /** YYYY-MM-DD */
  date: string
  /** false nos dias de preenchimento do mês vizinho. */
  inMonth: boolean
  isToday: boolean
  items: GoalWithProject[]
}

/** Segunda primeiro — semana pt-BR. */
export const WEEKDAY_LABELS: readonly string[] = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']

const WEEKS = 6

/**
 * Sempre 6 semanas, mesmo quando 5 bastariam: altura fixa evita o layout
 * pulando ao trocar de mês, e o custo é uma linha de dias vizinhos.
 */
export function buildMonthGrid(
  year: number,
  month: number,
  goals: readonly GoalWithProject[],
  todayIso: string,
): CalendarCell[] {
  const first = `${year}-${pad(month + 1)}-01`
  const start = mondayOf(first)
  const prefix = `${year}-${pad(month + 1)}-`

  const byDate = new Map<string, GoalWithProject[]>()
  for (const g of goals) {
    const date = g.goal.target_date
    if (date === null) continue
    const list = byDate.get(date)
    if (list) list.push(g)
    else byDate.set(date, [g])
  }

  return Array.from({ length: WEEKS * 7 }, (_, i) => {
    const date = addDays(start, i)
    return {
      date,
      inMonth: date.startsWith(prefix),
      isToday: date === todayIso,
      items: byDate.get(date) ?? [],
    }
  })
}

export function shiftMonth(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const total = year * 12 + month + delta
  return { year: Math.floor(total / 12), month: ((total % 12) + 12) % 12 }
}

// timeZone UTC nos dois: o instante é construído com Date.UTC, e formatar em
// fuso local jogaria o dia 1º para o mês anterior a oeste de Greenwich.
const monthFmt = new Intl.DateTimeFormat('pt-BR', {
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
})

export function monthLabel(year: number, month: number): string {
  return monthFmt.format(new Date(Date.UTC(year, month, 1)))
}

/** "3 de ago" — rótulo do chip de filtro por dia. */
const dayFmt = new Intl.DateTimeFormat('pt-BR', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
})

export function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  return dayFmt.format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)))
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}
