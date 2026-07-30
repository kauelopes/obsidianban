import type { TurnRunner, TurnResult } from '../planning/claude-runner.js'
import { SPRINT_STEPS, type SprintStepDef } from './steps.js'

/**
 * Modo de desenvolvimento (PLANNING_STUB=true): substitui o claude headless por
 * respostas sintéticas instantâneas e gratuitas — mesmo mecanismo do
 * stub-runner do wizard de projeto, adaptado às 5 etapas do wizard de sprint.
 */
export class SprintStubRunner implements TurnRunner {
  /** Retry corretivo não nomeia a etapa — responde-se a última vista. */
  private lastStep: SprintStepDef | null = null

  constructor(private readonly delayMs = 400) {}

  async runTurn(prompt: string, _resumeSessionId: string | null): Promise<TurnResult> {
    await new Promise((r) => setTimeout(r, this.delayMs))
    const def = this.matchStep(prompt) ?? this.lastStep
    if (!def) {
      return {
        ok: false,
        text: '',
        sessionId: 'sprint-stub-session',
        usage: { input: 0, output: 0, usd: 0 },
        rateLimited: false,
        error: 'stub: não reconheci a etapa no prompt',
      }
    }
    this.lastStep = def
    return {
      ok: true,
      text: JSON.stringify(this.buildResponse(def)),
      sessionId: 'sprint-stub-session',
      usage: { input: 0, output: 0, usd: 0 },
      rateLimited: false,
      error: null,
    }
  }

  cancel(): void {}

  private matchStep(prompt: string): SprintStepDef | null {
    const m = /(?:Próxima etapa:|pediu correção na etapa) "([^"]+)"/.exec(prompt)
    if (!m) return null
    return SPRINT_STEPS.find((s) => s.title === m[1]) ?? null
  }

  private buildResponse(def: SprintStepDef): Record<string, unknown> {
    const out: Record<string, unknown> = { screen_payload: this.payloadFor(def) }
    if (def.id === 'tasks') out['structure'] = this.structureFor()
    return out
  }

  private payloadFor(def: SprintStepDef): unknown {
    switch (def.screen) {
      case 'form':
        return {
          fields: [{ id: 'campo_a', label: `${def.title} — campo A`, help: 'stub', value: 'valor pré-preenchido A' }],
        }
      case 'choice':
        return {
          question: `${def.title}: qual opção? (stub)`,
          options: [
            { id: 'adhoc', label: 'Objetivo novo, sem épico', description: 'opção sintética' },
            { id: 'opcao-2', label: 'Opção 2', description: 'segunda opção sintética' },
          ],
          suggested: 'adhoc',
        }
      case 'confirm':
        return {
          markdown: `## ${def.title} (stub)\n\nTexto sintético para a tela de confirmação.\n\n- ponto um\n- ponto dois`,
        }
    }
  }

  private structureFor(): unknown {
    return {
      name: 'Sprint stub',
      goal: 'objetivo sintético da sprint stub',
      tasks: [
        { title: 'Tarefa um', type: 'task', body: '# Spec\nfazer algo', priority: 'medium', tags: ['stub'] },
        { title: 'Tarefa dois', type: 'feature', body: '# Spec\nfazer outra coisa', priority: 'high', tags: ['stub'] },
      ],
    }
  }
}
