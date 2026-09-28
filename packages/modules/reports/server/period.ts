const DAY_MS = 86_400_000

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isValidDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00.000Z`)) &&
    new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
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
