import { ClaudeCliProvider } from '../llm/claude-cli.js'

export interface TurnResult {
  ok: boolean
  /** Campo `result` do JSON do harness — o texto do modelo. */
  text: string
  sessionId: string | null
  usage: { input: number; output: number; usd: number }
  rateLimited: boolean
  error: string | null
}

export interface TurnRunner {
  runTurn(prompt: string, resumeSessionId: string | null): Promise<TurnResult>
  cancel(): void
}

export interface ClaudeRunnerOptions {
  /** cwd do spawn — um diretório neutro (.kanban/planning), nunca um repo. */
  cwd: string
  /** Override de modelo (PLANNING_MODEL); ausente herda o default do harness. */
  model?: string
  /** Kill do child após esse tempo (PLANNING_TURN_TIMEOUT_MS). */
  timeoutMs: number
}

export const DEFAULT_TURN_TIMEOUT_MS = 240_000

/**
 * Turno do wizard sobre o provider genérico `claude -p` (llm/claude-cli.ts).
 * O wizard continua falando TurnRunner; o que este adapter acrescenta é o
 * cancel() do turno em voo, que o wizard usa quando o humano abandona a etapa.
 */
export class ClaudeRunner implements TurnRunner {
  private readonly provider: ClaudeCliProvider
  private inFlight: AbortController | null = null

  constructor(opts: ClaudeRunnerOptions) {
    this.provider = new ClaudeCliProvider(opts)
  }

  async runTurn(prompt: string, resumeSessionId: string | null): Promise<TurnResult> {
    const ctrl = new AbortController()
    this.inFlight = ctrl
    try {
      return await this.provider.complete({ prompt, resumeSessionId, signal: ctrl.signal })
    } finally {
      if (this.inFlight === ctrl) this.inFlight = null
    }
  }

  cancel(): void {
    this.inFlight?.abort()
    this.inFlight = null
  }
}
