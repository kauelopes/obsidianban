import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import type { LlmCompletion, LlmProvider, LlmRequest } from '@obsidiankan/module-sdk'
import { logger } from '../util/logger.js'

// Mesmo padrão de detecção do sprint-workflow: o harness devolve is_error com
// uma mensagem de limite; quem chama decide se isso vira retry ou estado.
const RATE_LIMIT_RE =
  /hit your (session|weekly|daily|monthly|hourly) limit|rate.?limit|credits? (exhausted|insufficient)|too many requests/i

export interface ClaudeCliOptions {
  /** cwd do spawn — um diretório neutro (.kanban/...), nunca um repo. */
  cwd: string
  /** Override de modelo; ausente herda o default do harness. */
  model?: string | undefined
  /** Kill do child após esse tempo. */
  timeoutMs: number
}

/**
 * Uma chamada = um spawn de `claude -p` headless com --output-format json; o
 * contexto entre chamadas vem do --resume <session_id> do harness, não de
 * histórico gerenciado aqui. Sem MCP e sem settings: geração de texto pura —
 * todo efeito colateral fica no servidor.
 */
export class ClaudeCliProvider implements LlmProvider {
  readonly id = 'claude-cli'
  readonly model: string | null

  constructor(private readonly opts: ClaudeCliOptions) {
    this.model = opts.model ?? null
  }

  async complete(req: LlmRequest): Promise<LlmCompletion> {
    await fs.mkdir(this.opts.cwd, { recursive: true })
    if (req.signal?.aborted) return failedCompletion('cancelado antes de começar')
    return new Promise((resolve) => {
      const args = [
        '-p', req.prompt,
        '--output-format', 'json',
        '--strict-mcp-config',
        ...(req.resumeSessionId ? ['--resume', req.resumeSessionId] : []),
        ...(this.opts.model ? ['--model', this.opts.model] : []),
      ]
      // Sem ANTHROPIC_API_KEY: com a variável presente o CLI cobra da API key
      // em vez da conta logada (assinatura) do usuário. O sprint-workflow, que
      // precisa da key para o SDK, herda o env do servidor por outro caminho.
      const env = { ...process.env }
      delete env['ANTHROPIC_API_KEY']
      const child = spawn('claude', args, { cwd: this.opts.cwd, env })
      let stdout = ''
      let stderr = ''
      let settled = false
      const onAbort = (): void => {
        child.kill('SIGTERM')
        finish(failedCompletion('cancelado'))
      }
      const finish = (r: LlmCompletion): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        req.signal?.removeEventListener('abort', onAbort)
        resolve(r)
      }
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(failedCompletion(`turno excedeu ${this.opts.timeoutMs}ms e foi encerrado`))
      }, this.opts.timeoutMs)
      req.signal?.addEventListener('abort', onAbort)

      child.stdout?.on('data', (d) => (stdout += d.toString()))
      child.stderr?.on('data', (d) => (stderr += d.toString()))
      child.on('error', (err) => {
        // ENOENT = CLI ausente no host — erro de ambiente, não do turno.
        logger.error({ err }, 'llm: claude spawn failed')
        finish(failedCompletion(`spawn error: ${err.message} (o CLI 'claude' está no PATH?)`))
      })
      child.on('close', () => {
        let j: Record<string, unknown>
        try {
          j = JSON.parse(stdout) as Record<string, unknown>
        } catch {
          finish(failedCompletion(`saída do harness não parseável: ${(stderr || stdout).slice(-500)}`))
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
}

export function failedCompletion(msg: string): LlmCompletion {
  return {
    ok: false,
    text: '',
    sessionId: null,
    usage: { input: 0, output: 0, usd: 0 },
    rateLimited: false,
    error: msg,
  }
}
