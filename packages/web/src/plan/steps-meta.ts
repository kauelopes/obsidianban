import type { PlanningScreenType } from '@obsidiankan/types'

/**
 * Espelho da sequência declarada no servidor (packages/server/src/planning/
 * steps.ts) — só metadados de exibição: título, tipo de tela e fase. O
 * conteúdo das telas vem sempre do servidor em outputs[step].screen_payload.
 */
export interface StepMeta {
  id: string
  title: string
  screen: PlanningScreenType
  phase: PlanPhaseId
}

export type PlanPhaseId = 'contexto' | 'descoberta' | 'arquitetura' | 'plano'

/** As 15 etapas agrupadas em 4 fases — o stepper mostra fases, não etapas. */
export const PLAN_PHASES: readonly { id: PlanPhaseId; title: string }[] = [
  { id: 'contexto', title: 'Contexto' },
  { id: 'descoberta', title: 'Descoberta' },
  { id: 'arquitetura', title: 'Arquitetura' },
  { id: 'plano', title: 'Plano' },
]

export const PLAN_STEPS: readonly StepMeta[] = [
  { id: 'identity', title: 'Identidade', screen: 'form', phase: 'contexto' },
  { id: 'project_type', title: 'Tipo', screen: 'choice', phase: 'contexto' },
  { id: 'scope', title: 'Escopo', screen: 'form', phase: 'contexto' },
  { id: 'users', title: 'Usuários', screen: 'list', phase: 'descoberta' },
  { id: 'stories', title: 'Histórias', screen: 'list', phase: 'descoberta' },
  { id: 'use_cases', title: 'Casos de uso', screen: 'confirm', phase: 'descoberta' },
  { id: 'domain_model', title: 'Domínio', screen: 'diagram', phase: 'arquitetura' },
  { id: 'modules', title: 'Módulos', screen: 'list', phase: 'arquitetura' },
  { id: 'communication', title: 'Comunicação', screen: 'diagram', phase: 'arquitetura' },
  { id: 'roadmap', title: 'Roadmap', screen: 'confirm', phase: 'plano' },
  { id: 'milestones', title: 'Milestones', screen: 'confirm', phase: 'plano' },
  { id: 'epics_features', title: 'Épicos', screen: 'confirm', phase: 'plano' },
  { id: 'sprints_tasks', title: 'Sprints', screen: 'confirm', phase: 'plano' },
  { id: 'risks_metrics', title: 'Riscos', screen: 'form', phase: 'plano' },
  { id: 'review', title: 'Revisão', screen: 'confirm', phase: 'plano' },
]

export function stepMeta(id: string): StepMeta | null {
  return PLAN_STEPS.find((s) => s.id === id) ?? null
}

export function stepIndex(id: string): number {
  return PLAN_STEPS.findIndex((s) => s.id === id)
}
