import path from 'node:path'
import type { LlmProvider } from '@obsidiankan/module-sdk'
import { ClaudeCliProvider } from './claude-cli.js'
import { StubLlmProvider } from './stub.js'
import { MODULE_LLM_TIMEOUT_MS } from '../util/constants.js'

/**
 * LLM que cada módulo recebe no contexto. Mesma convenção do planning:
 * MODULES_LLM_STUB=true troca por respostas sintéticas (dev, sem custo);
 * MODULES_LLM_MODEL e MODULES_LLM_TIMEOUT_MS ajustam o `claude` headless.
 */
export function createModuleLlm(
  env: Readonly<Record<string, string | undefined>>,
  dataDir: string,
): LlmProvider {
  const stub = env['MODULES_LLM_STUB'] === 'true' || env['MODULES_LLM_STUB'] === '1'
  if (stub) return new StubLlmProvider()
  const timeout = Number(env['MODULES_LLM_TIMEOUT_MS'] ?? MODULE_LLM_TIMEOUT_MS)
  return new ClaudeCliProvider({
    cwd: path.join(dataDir, 'llm'),
    model: env['MODULES_LLM_MODEL'] || undefined,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : MODULE_LLM_TIMEOUT_MS,
  })
}
