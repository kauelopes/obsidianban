/**
 * ISO cru na tela é dado de máquina onde deveria haver leitura humana. O ISO
 * completo continua disponível em title=/dateTime; aqui só muda o que o olho
 * varre. Uma string que não parseia volta como veio — o vault real tem
 * timestamps soltos e mentir "Invalid Date" seria pior que mostrar o cru.
 */
const fmt = new Intl.DateTimeFormat('pt-BR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})

export function humanTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : fmt.format(d)
}

/**
 * "há 2 h" em vez de timestamp: num hub de supervisão, recência é o dado —
 * o instante exato fica no title= via humanTime. `now` é injetável só para
 * teste; um relógio adiantado no servidor cai no ramo "agora".
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const s = Math.floor((now.getTime() - d.getTime()) / 1000)
  if (s < 60) return 'agora'
  if (s < 3600) return `há ${Math.floor(s / 60)} min`
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`
  const days = Math.floor(s / 86400)
  return days === 1 ? 'há 1 dia' : `há ${days} dias`
}

/* ── Datas puras (YYYY-MM-DD) ──────────────────────────────────────────────
 * Prazo de meta é data civil, não instante: comparar via `new Date(iso)` e
 * `toISOString()` erra o dia perto da virada (o construtor lê YYYY-MM-DD como
 * meia-noite UTC, o relógio local não). Tudo aqui trabalha na string ou em
 * Date.UTC dos componentes, e nunca mistura os dois.
 */

/** Hoje no fuso do navegador. 'sv' é o atalho de locale que já sai ISO. */
export function todayIso(now: Date = new Date()): string {
  return now.toLocaleDateString('sv')
}

/** Dias inteiros de `fromIso` até `toIso` — negativo se `toIso` já passou. */
export function diffDays(fromIso: string, toIso: string): number {
  return Math.round((utcOf(toIso) - utcOf(fromIso)) / 86_400_000)
}

/** YYYY-MM-DD → dd/mm, sem passar por Date (é data pura, fuso não entra). */
export function fmtDay(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

/** Segunda-feira da semana que contém `iso` (semana pt-BR: seg–dom). */
export function mondayOf(iso: string): string {
  const d = new Date(utcOf(iso))
  // getUTCDay: 0=dom … 6=sáb. Domingo fecha a semana anterior, recua 6.
  const back = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

/** Soma dias a uma data civil, devolvendo YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  return new Date(utcOf(iso) + days * 86_400_000).toISOString().slice(0, 10)
}

function utcOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}
