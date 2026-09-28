import { localDate } from './api.js'

export interface PeriodPreset {
  id: string
  label: string
  from: string
  to: string
}

function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + days)
  return localDate(d)
}

/** Atalhos de período a partir de "hoje" (fuso do navegador), pontas inclusivas. */
export function periodPresets(today: string = localDate()): PeriodPreset[] {
  const [y, m] = today.split('-').map(Number) as [number, number]
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`
  const prevMonthEnd = shift(monthStart, -1)
  const prevMonthStart = `${prevMonthEnd.slice(0, 7)}-01`
  return [
    { id: '7d', label: 'Últimos 7 dias', from: shift(today, -6), to: today },
    { id: '30d', label: 'Últimos 30 dias', from: shift(today, -29), to: today },
    { id: 'mes', label: 'Mês atual', from: monthStart, to: today },
    { id: 'mes-anterior', label: 'Mês anterior', from: prevMonthStart, to: prevMonthEnd },
    { id: '90d', label: 'Últimos 90 dias', from: shift(today, -89), to: today },
  ]
}
