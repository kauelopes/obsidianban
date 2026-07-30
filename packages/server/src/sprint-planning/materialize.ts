import type { TokenClaims } from '@obsidiankan/types'
import { wizardActorTag } from '../planning/wizard-actor.js'
import type { SprintService } from '../services/sprint.js'
import type { CardService } from '../services/card.js'
import type { SprintPlanningSession } from './session.js'
import type { FinalSprint } from './structure-schema.js'

const BULK_BATCH = 100

export interface SprintMaterializeDeps {
  sprints: SprintService
  cards: CardService
  /** Rótulo do modelo que roda os turnos do wizard — vira o actor `<modelo>:sprint-wizard`. */
  modelLabel: string
  /** Persiste a sessão após cada fase — é o checkpoint da retomada. */
  saveSession(session: SprintPlanningSession): Promise<void>
}

export interface SprintMaterializeResult {
  project: string
  sprint_id: string
  new_cards_created: number
  new_cards_failed: Array<{ index: number; error: string }>
}

export type SprintMaterializer = (
  session: SprintPlanningSession,
  structure: FinalSprint,
  claims: TokenClaims,
) => Promise<SprintMaterializeResult>

/**
 * Materializa a sprint final no board: cria a sprint (em planning) e cria as
 * tarefas novas. Bem menor que o wizard de projeto — sem criação de
 * projeto/token, sem KAD. Mesmo padrão de checkpoint idempotente (retomável
 * após falha parcial).
 */
export function createSprintMaterializer(deps: SprintMaterializeDeps): SprintMaterializer {
  return async (session, structure, claims) => {
    const project = session.project
    const cp = (session.materialization ??= {})
    const save = () => deps.saveSession(session)
    // Quem decidiu objetivo e tarefas foi o modelo, não o humano que clicou em
    // "finalizar" — o actor gravado no CREATE reflete isso (mesma técnica do
    // wizard de projeto, com um sufixo próprio para diferenciar no audit log).
    const wizardActor = wizardActorTag(deps.modelLabel, 'sprint-wizard')
    const wizardClaims: TokenClaims = { ...claims, actor: wizardActor }

    // 1. Sprint (fica em planning — ativar é decisão humana posterior)
    if (!cp.sprint_created) {
      const created = await deps.sprints.createSprint(
        { project, name: structure.name, goal: structure.goal },
        wizardClaims,
      )
      cp.sprint_created = created.id
      await save()
    }
    const sprintId = cp.sprint_created!

    // 2. Tarefas novas, em lotes ≤100 — falha por card vira relatório
    let alreadyCreated = cp.new_cards ?? 0
    const failed: SprintMaterializeResult['new_cards_failed'] = []
    for (let i = alreadyCreated; i < structure.tasks.length; i += BULK_BATCH) {
      const batch = structure.tasks.slice(i, i + BULK_BATCH)
      const res = await deps.cards.bulkCreate(
        {
          project,
          sprint_id: sprintId,
          cards: batch.map((t) => ({
            title: t.title,
            type: t.type,
            ...(t.body ? { body: t.body } : {}),
            ...(t.priority ? { priority: t.priority } : {}),
            ...(t.tags ? { tags: t.tags } : {}),
          })),
          input_tokens: 0,
          output_tokens: 0,
        },
        wizardClaims,
      )
      alreadyCreated += res.created.length
      for (const f of res.failed) failed.push({ index: i + f.index, error: f.error })
      cp.new_cards = i + batch.length
      await save()
    }

    return {
      project,
      sprint_id: sprintId,
      new_cards_created: alreadyCreated,
      new_cards_failed: failed,
    }
  }
}
