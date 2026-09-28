import type { Goal } from '@obsidiankan/types'
import { diffDays } from '../util/time.js'

/**
 * Urgência de uma meta no tile do hub. Vencida já era destacada; "vence esta
 * semana" também pede decisão (replanejar ou correr) e passava batido — mas
 * num tom mais fraco, para a vencida continuar sendo a pior notícia da tela.
 */

export type GoalUrgency = 'ok' | 'due-soon' | 'overdue'

const DUE_SOON_DAYS = 7

export function goalUrgency(goal: Goal, todayIso: string): GoalUrgency {
  if (goal.status !== 'open' || goal.target_date === null) return 'ok'
  const days = diffDays(todayIso, goal.target_date)
  if (days < 0) return 'overdue'
  return days <= DUE_SOON_DAYS ? 'due-soon' : 'ok'
}
