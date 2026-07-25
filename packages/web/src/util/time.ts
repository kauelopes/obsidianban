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
