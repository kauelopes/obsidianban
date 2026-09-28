// Formatação pt-BR usada no documento. Um lugar só: o Markdown e o PDF recebem
// strings já formatadas, então "1.234" nunca vira "1,234" numa das saídas.

const INT = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 })
const ONE = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const USD = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function fmtInt(n: number): string {
  return INT.format(n)
}

export function fmtUsd(n: number): string {
  return `US$ ${USD.format(n)}`
}

export function fmtPct(ratio: number): string {
  return `${INT.format(Math.round(ratio * 100))}%`
}

/** Horas legíveis: minutos abaixo de 1 h, dias acima de 48 h. */
export function fmtHours(h: number): string {
  if (h <= 0) return '0 h'
  if (h < 1) return `${INT.format(Math.max(1, Math.round(h * 60)))} min`
  if (h > 48) return `${ONE.format(h / 24)} d`
  return `${ONE.format(h)} h`
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${ONE.format(n / 1_000_000)} mi`
  if (n >= 10_000) return `${INT.format(Math.round(n / 1000))} mil`
  return INT.format(n)
}

/** YYYY-MM-DD ou ISO completo → dd/mm/aaaa. */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return y && m && d ? `${d}/${m}/${y}` : iso
}

export function fmtPeriod(p: { from: string; to: string }): string {
  return p.from === p.to ? fmtDate(p.from) : `${fmtDate(p.from)} – ${fmtDate(p.to)}`
}
