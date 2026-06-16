import type { CardRepository } from '../cards/repository.js'
import type { TokenClaims } from '@obsidiankan/types'
import { HttpError, forbidden, badRequest } from './errors.js'

export function assertWritable(assignedTo: string | null, claims: TokenClaims): void {
  if (claims.role === 'manager') return
  if (assignedTo == null) return
  if (assignedTo === claims.actor) return
  throw forbidden('not_assigned', { assigned_to: assignedTo })
}

export function isAdvancingBeyondTodo(toStatus: string, fromStatus: string): boolean {
  const unstarted = new Set(['backlog', 'todo'])
  return !unstarted.has(toStatus) && unstarted.has(fromStatus)
}

export function unmetBlockers(
  repo: CardRepository,
  blockerIds: readonly string[],
): Array<{ id: string; status: string | 'missing' }> {
  const unmet: Array<{ id: string; status: string | 'missing' }> = []
  for (const blockerId of blockerIds) {
    const row = repo.findById(blockerId)
    if (!row) {
      unmet.push({ id: blockerId, status: 'missing' })
      continue
    }
    if (row.status === 'done') continue
    if (row.archived === 1) continue
    unmet.push({ id: blockerId, status: row.status })
  }
  return unmet
}

export function blockedConflict(
  unmet: Array<{ id: string; status: string | 'missing' }>,
): HttpError {
  return new HttpError(409, {
    error: 'blocked',
    message: 'card has unsatisfied dependencies',
    blockers: unmet,
  })
}

export function sprintNotActiveError(sprint: { id: string; name: string; status: string }): HttpError {
  const isPlanning = sprint.status === 'planning'
  return badRequest('sprint_not_active', {
    message: isPlanning
      ? `Sprint "${sprint.name}" is still in planning — start it before advancing cards.`
      : `Sprint "${sprint.name}" is closed — cards in a closed sprint cannot move forward.`,
    sprint_id: sprint.id,
    sprint_status: sprint.status,
    hint: isPlanning
      ? 'Call kanban_start_sprint to activate this sprint.'
      : 'Use kanban_move_between_sprints to move the card to an active or planning sprint.',
    next_action: isPlanning
      ? { tool: 'kanban_start_sprint', params: { sprint_id: sprint.id } }
      : { tool: 'kanban_move_between_sprints' },
  })
}

export function safeParseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v
    return []
  } catch {
    return []
  }
}
