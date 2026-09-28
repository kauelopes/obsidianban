const DAY_MS = 86_400_000

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`)) &&
    new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s
}

/** Data UTC de um Date — só para aritmética de datas (addDays, mondayOf). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Dia no fuso do servidor (o da máquina do usuário). Timestamps ficam em UTC
 * no vault; tudo que vira "dia" para uma pessoa — hoje, gerado em, início e
 * fim de sprint — passa por aqui. Em UTC-3, 22h do dia 27 é dia 28 em UTC.
 * Data pura (YYYY-MM-DD) já é dia e volta como veio.
 */
export function localDay(value: string | Date): string {
  if (typeof value === 'string' && DATE_RE.test(value)) return value
  const d = typeof value === 'string' ? new Date(value) : value
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Meia-noite local do dia seguinte, em ISO — fim exclusivo de um bucket diário. */
export function localDayEndIso(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(y, m - 1, d + 1).toISOString()
}

export function addDays(iso: string, days: number): string {
  return isoDate(new Date(Date.parse(`${iso}T00:00:00.000Z`) + days * DAY_MS))
}

/** Dias do período, inclusive nas duas pontas. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS) + 1
}

export function eachDay(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

export function mondayOf(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return isoDate(d)
}

/** Duas janelas [a, b] se tocam (datas YYYY-MM-DD, pontas inclusivas). */
export function overlaps(aFrom: string, aTo: string, bFrom: string, bTo: string): boolean {
  return aFrom <= bTo && bFrom <= aTo
}
