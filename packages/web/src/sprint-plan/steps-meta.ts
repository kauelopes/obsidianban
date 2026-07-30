import type { PlanningScreenType } from '@obsidiankan/types'

/**
 * Espelho da sequência declarada no servidor (packages/server/src/sprint-planning/
 * steps.ts) — só metadados de exibição: título e tipo de tela. O conteúdo das
 * telas vem sempre do servidor em outputs[step].screen_payload.
 */
export interface SprintStepMeta {
  id: string
  title: string
  screen: PlanningScreenType
}

/** As 5 etapas — poucas o bastante para um stepper linear, sem agrupar em fases. */
export const SPRINT_STEPS: readonly SprintStepMeta[] = [
  { id: 'capacity', title: 'Capacidade', screen: 'form' },
  { id: 'goal', title: 'Objetivo', screen: 'choice' },
  { id: 'tasks', title: 'Tarefas', screen: 'confirm' },
  { id: 'risks', title: 'Riscos', screen: 'form' },
  { id: 'review', title: 'Revisão', screen: 'confirm' },
]

export function sprintStepMeta(id: string): SprintStepMeta | null {
  return SPRINT_STEPS.find((s) => s.id === id) ?? null
}

export function sprintStepIndex(id: string): number {
  return SPRINT_STEPS.findIndex((s) => s.id === id)
}
