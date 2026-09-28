import type { LlmCompletion, LlmProvider, LlmRequest } from '@obsidiankan/module-sdk'

/**
 * Provider sem LLM para desenvolvimento e testes: responde na hora, de graça,
 * com o texto que `respond` montar a partir do prompt. O default devolve um
 * Markdown curto e explícito sobre ser sintético — nunca parece análise real.
 */
export class StubLlmProvider implements LlmProvider {
  readonly id = 'stub'
  readonly model = null

  constructor(
    private readonly respond: (prompt: string) => string = defaultStubText,
    private readonly delayMs = 200,
  ) {}

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    await new Promise((r) => setTimeout(r, this.delayMs))
    return {
      ok: true,
      text: this.respond(req.prompt),
      sessionId: 'stub-session',
      usage: { input: 0, output: 0, usd: 0 },
      rateLimited: false,
      error: null,
    }
  }
}

function defaultStubText(prompt: string): string {
  return [
    '## Resumo',
    '',
    `Texto sintético do modo stub (prompt de ${prompt.length} caracteres) — nenhum LLM foi chamado.`,
    '',
    '## Destaques',
    '',
    '- Item de exemplo gerado sem análise.',
    '',
    '## Riscos',
    '',
    '- Nenhum risco avaliado: modo stub.',
    '',
    '## Recomendações',
    '',
    '- Desligue o modo stub para obter a análise real.',
  ].join('\n')
}
