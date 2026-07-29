import type { TurnRunner, TurnResult } from './claude-runner.js'
import { STEPS, type StepDef } from './steps.js'
import type { KadDocId } from './session.js'

/**
 * Modo de desenvolvimento (PLANNING_STUB=true): substitui o claude headless por
 * respostas sintéticas instantâneas e gratuitas, para iterar na interface do
 * wizard sem custo de LLM. Detecta a etapa pelo próprio prompt (os três tipos —
 * prefill, refine e retry — carregam marcadores estáveis) e devolve JSON que
 * passa nos parsers reais, então o restante do fluxo (sessão, SSE, finalize)
 * roda idêntico à produção.
 */
export class StubRunner implements TurnRunner {
  /** Retry corretivo não nomeia a etapa — responde-se a última vista. */
  private lastStep: StepDef | null = null

  constructor(private readonly delayMs = 400) {}

  async runTurn(prompt: string, _resumeSessionId: string | null): Promise<TurnResult> {
    await new Promise((r) => setTimeout(r, this.delayMs))
    const def = this.matchStep(prompt) ?? this.lastStep
    if (!def) {
      return {
        ok: false,
        text: '',
        sessionId: 'stub-session',
        usage: { input: 0, output: 0, usd: 0 },
        rateLimited: false,
        error: 'stub: não reconheci a etapa no prompt',
      }
    }
    this.lastStep = def
    return {
      ok: true,
      text: JSON.stringify(this.buildResponse(def, prompt)),
      sessionId: 'stub-session',
      usage: { input: 0, output: 0, usd: 0 },
      rateLimited: false,
      error: null,
    }
  }

  cancel(): void {}

  private matchStep(prompt: string): StepDef | null {
    const m = /(?:Próxima etapa:|pediu correção na etapa) "([^"]+)"/.exec(prompt)
    if (!m) return null
    return STEPS.find((s) => s.title === m[1]) ?? null
  }

  private buildResponse(def: StepDef, prompt: string): Record<string, unknown> {
    const kad_patch: Partial<Record<KadDocId, string>> = {}
    for (const doc of def.kadDocs) {
      kad_patch[doc] = `# ${doc} (stub)\n\nConteúdo sintético do modo de desenvolvimento — etapa "${def.title}".`
    }
    const out: Record<string, unknown> = { screen_payload: this.payloadFor(def), kad_patch }
    if (def.id === 'sprints_tasks') out['structure'] = this.structureFor(prompt)
    return out
  }

  private payloadFor(def: StepDef): unknown {
    switch (def.screen) {
      case 'form':
        return {
          fields: [
            { id: 'campo_a', label: `${def.title} — campo A`, help: 'stub', value: 'valor pré-preenchido A' },
            { id: 'campo_b', label: `${def.title} — campo B`, value: 'valor pré-preenchido B' },
          ],
        }
      case 'choice':
        return {
          question: `${def.title}: qual opção? (stub)`,
          options: [
            { id: 'opcao-1', label: 'Opção 1', description: 'primeira opção sintética' },
            { id: 'opcao-2', label: 'Opção 2', description: 'segunda opção sintética' },
            { id: 'opcao-3', label: 'Opção 3' },
          ],
          suggested: 'opcao-1',
        }
      case 'list':
        return {
          intro: `${def.title} (stub) — edite, remova ou adicione itens.`,
          items: [
            { id: 'item-1', title: 'Item um', detail: 'detalhe sintético do item um' },
            { id: 'item-2', title: 'Item dois', detail: 'detalhe sintético do item dois' },
            { id: 'item-3', title: 'Item três' },
          ],
        }
      case 'diagram':
        return {
          mermaid: `flowchart TD\n  A["Módulo A"] -- "fluxo -- com aspas" --> B["Módulo B"]\n  B --> C[(Base)]`,
          caption: `${def.title} (stub) — confirme ou peça correção.`,
        }
      case 'confirm':
        return {
          markdown: `## ${def.title} (stub)\n\nTexto sintético para a tela de confirmação.\n\n- ponto um\n- ponto dois\n\n\`\`\`mermaid\nflowchart LR\n  X --> Y\n\`\`\``,
        }
    }
  }

  private structureFor(prompt: string): unknown {
    // O nome real vem do bloco de respostas re-enviado no prompt; a identidade
    // já validou a regex de projeto, então o primeiro "name" é seguro.
    const name = /"name":\s*"([^"]+)"/.exec(prompt)?.[1] ?? 'projeto-stub'
    return {
      project: { name },
      goals: [{ title: 'Meta stub', target_date: null, notes: 'meta sintética' }],
      epics: [
        {
          name: 'Épico stub',
          objective: 'validar a interface sem custo de LLM',
          sprints: [
            {
              name: 'Sprint stub 1',
              goal: 'primeira sprint sintética',
              tasks: [
                { title: 'Tarefa um', type: 'task', body: '# Spec\nfazer algo', priority: 'medium', tags: ['stub'] },
                { title: 'Tarefa dois', type: 'feature', body: '# Spec\nfazer outra coisa', priority: 'high', tags: ['stub'] },
                { title: 'Tarefa três', type: 'chore', body: '# Spec\narrumar a casa', priority: 'low', tags: ['stub'] },
              ],
            },
          ],
        },
      ],
    }
  }
}
