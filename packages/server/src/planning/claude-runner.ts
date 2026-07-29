import { spawn, type ChildProcess } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { logger } from '../util/logger.js'

// Mesmo padrão de detecção do sprint-workflow: o harness devolve is_error com
// uma mensagem de limite; aqui o humano está na frente da tela, então nada de
// sleep — o erro vira estado recuperável e a UI oferece "tentar de novo".
const RATE_LIMIT_RE =
  /hit your (session|weekly|daily|monthly|hourly) limit|rate.?limit|credits? (exhausted|insufficient)|too many requests/i

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
 * Um turno = um spawn de `claude -p` headless com --output-format json;
 * o contexto entre turnos vem do --resume <session_id> do harness, não de
 * histórico gerenciado aqui. Sem MCP e sem settings: o turno é geração de
 * texto pura — todo efeito colateral fica no servidor.
 */
export class ClaudeRunner implements TurnRunner {
  private child: ChildProcess | null = null

  constructor(private readonly opts: ClaudeRunnerOptions) {}

  async runTurn(prompt: string, resumeSessionId: string | null): Promise<TurnResult> {
    await fs.mkdir(this.opts.cwd, { recursive: true })
    return new Promise((resolve) => {
      const args = [
        '-p', prompt,
        '--output-format', 'json',
        '--strict-mcp-config',
        ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
        ...(this.opts.model ? ['--model', this.opts.model] : []),
      ]
      // Sem ANTHROPIC_API_KEY: com a variável presente o CLI cobra da API key
      // em vez da conta logada (assinatura) do usuário. O sprint-workflow, que
      // precisa da key para o SDK, herda o env do servidor por outro caminho.
      const env = { ...process.env }
      delete env['ANTHROPIC_API_KEY']
      const child = spawn('claude', args, { cwd: this.opts.cwd, env })
      this.child = child
      let stdout = ''
      let stderr = ''
      let settled = false
      const finish = (r: TurnResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.child = null
        resolve(r)
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(failedTurn(`turno excedeu ${this.opts.timeoutMs}ms e foi encerrado`))
      }, this.opts.timeoutMs)

      child.stdout?.on('data', (d) => (stdout += d.toString()))
      child.stderr?.on('data', (d) => (stderr += d.toString()))
      child.on('error', (err) => {
        // ENOENT = CLI ausente no host — erro de ambiente, não do turno.
        logger.error({ err }, 'planning: claude spawn failed')
        finish(failedTurn(`spawn error: ${err.message} (o CLI 'claude' está no PATH?)`))
      })
      child.on('close', () => {
        let j: Record<string, unknown>
        try {
          j = JSON.parse(stdout) as Record<string, unknown>
        } catch {
          finish(failedTurn(`saída do harness não parseável: ${(stderr || stdout).slice(-500)}`))
          return
        }
        const u = (j['usage'] ?? {}) as Record<string, unknown>
        const text = String(j['result'] ?? '')
        const isError = Boolean(j['is_error'])
        finish({
          ok: !isError,
          text,
          sessionId: typeof j['session_id'] === 'string' ? j['session_id'] : null,
          usage: {
            input: Number(u['input_tokens'] ?? 0),
            output: Number(u['output_tokens'] ?? 0),
            usd: Number(j['total_cost_usd'] ?? 0),
          },
          rateLimited: isError && RATE_LIMIT_RE.test(text),
          error: isError ? text.slice(0, 500) : null,
        })
      })
    })
  }

  cancel(): void {
    this.child?.kill('SIGTERM')
    this.child = null
  }
}

function failedTurn(msg: string): TurnResult {
  return {
    ok: false,
    text: '',
    sessionId: null,
    usage: { input: 0, output: 0, usd: 0 },
    rateLimited: false,
    error: msg,
  }
}
