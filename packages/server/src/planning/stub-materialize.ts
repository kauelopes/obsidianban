import { logger } from '../util/logger.js'
import type { Materializer, MaterializeResult } from './materialize.js'

/**
 * Modo de desenvolvimento (PLANNING_STUB=true): substitui a materialização real
 * por um resultado sintético — nenhum projeto, épico, sprint ou card é criado
 * de verdade, e nada é gravado no vault (nem o KAD). Sem isso, PLANNING_STUB só
 * trocava os turnos do LLM; finalizar o wizard ainda escrevia no board real.
 */
export function createStubMaterializer(): Materializer {
  return async (session, structure): Promise<MaterializeResult> => {
    logger.warn(
      { project: structure.project.name },
      'planning: PLANNING_STUB ativo — materialização simulada, nada foi escrito',
    )
    const sprintCount = structure.epics.reduce((n, e) => n + e.sprints.length, 0)
    const cardsCount = structure.epics.reduce(
      (n, e) => n + e.sprints.reduce((m, s) => m + s.tasks.length, 0),
      0,
    )
    return {
      project: structure.project.name,
      token: null,
      token_id: null,
      token_hint: 'PLANNING_STUB ativo — nenhum token real foi gerado',
      epics: structure.epics.length,
      sprints: sprintCount,
      cards_created: cardsCount,
      cards_failed: [],
      goals: structure.goals?.length ?? 0,
      kad_files: Object.keys(session.kad).map((doc) => `kad/${doc}.md`),
      repo_copy_ok: null,
    }
  }
}
