import { logger } from '../util/logger.js'
import type { SprintMaterializer, SprintMaterializeResult } from './materialize.js'

/**
 * Modo de desenvolvimento (PLANNING_STUB=true): substitui a materialização real
 * por um resultado sintético — nenhuma sprint ou card é criado de verdade. Sem
 * isso, PLANNING_STUB só trocava os turnos do LLM; o botão "Materializar
 * sprint" ainda escrevia no vault/board reais.
 */
export function createStubSprintMaterializer(): SprintMaterializer {
  return async (session, structure): Promise<SprintMaterializeResult> => {
    logger.warn(
      { project: session.project, session_id: session.session_id },
      'sprint-planning: PLANNING_STUB ativo — materialização simulada, nada foi escrito',
    )
    return {
      project: session.project,
      sprint_id: `stub-${session.session_id}`,
      new_cards_created: structure.tasks.length,
      new_cards_failed: [],
    }
  }
}
