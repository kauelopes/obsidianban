import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ClaudeCliProvider } from '../../src/llm/claude-cli.js'
import { StubLlmProvider } from '../../src/llm/stub.js'
import { createModuleLlm } from '../../src/llm/factory.js'
import { ClaudeRunner } from '../../src/planning/claude-runner.js'

// Um `claude` falso no PATH: o comportamento depende do prompt, que é o
// segundo argumento (`-p <prompt>`).
const FAKE = `#!/bin/sh
case "$2" in
  ok) echo '{"result":"olá","session_id":"s-1","is_error":false,"total_cost_usd":0.5,"usage":{"input_tokens":10,"output_tokens":3}}' ;;
  limit) echo '{"result":"You have hit your session limit","is_error":true}' ;;
  lixo) echo 'não é json' ;;
  lento) sleep 5 ;;
esac
`

let dir: string
let prevPath: string | undefined

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-claude-'))
  await fs.writeFile(path.join(dir, 'claude'), FAKE, { mode: 0o755 })
  prevPath = process.env['PATH']
  process.env['PATH'] = `${dir}:${prevPath}`
})

afterAll(async () => {
  process.env['PATH'] = prevPath
  await fs.rm(dir, { recursive: true, force: true })
})

function provider(timeoutMs = 2_000) {
  return new ClaudeCliProvider({ cwd: path.join(dir, 'cwd'), timeoutMs })
}

describe('ClaudeCliProvider', () => {
  it('parseia texto, sessão e uso do JSON do harness', async () => {
    const r = await provider().complete({ prompt: 'ok' })
    expect(r).toEqual({
      ok: true,
      text: 'olá',
      sessionId: 's-1',
      usage: { input: 10, output: 3, usd: 0.5 },
      rateLimited: false,
      error: null,
    })
  })

  it('is_error com mensagem de limite vira rateLimited', async () => {
    const r = await provider().complete({ prompt: 'limit' })
    expect(r.ok).toBe(false)
    expect(r.rateLimited).toBe(true)
  })

  it('saída não-JSON vira erro legível, não exceção', async () => {
    const r = await provider().complete({ prompt: 'lixo' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('não parseável')
  })

  it('timeout mata o processo e devolve erro', async () => {
    const r = await provider(200).complete({ prompt: 'lento' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('excedeu 200ms')
  })

  it('signal abortado cancela a chamada em voo', async () => {
    const ctrl = new AbortController()
    const p = provider().complete({ prompt: 'lento', signal: ctrl.signal })
    setTimeout(() => ctrl.abort(), 50)
    const r = await p
    expect(r).toMatchObject({ ok: false, error: 'cancelado' })
  })
})

describe('ClaudeRunner (adapter do planning)', () => {
  it('runTurn delega ao provider e cancel() aborta o turno em voo', async () => {
    const runner = new ClaudeRunner({ cwd: path.join(dir, 'cwd'), timeoutMs: 2_000 })
    expect((await runner.runTurn('ok', null)).text).toBe('olá')
    const turn = runner.runTurn('lento', null)
    setTimeout(() => runner.cancel(), 50)
    expect((await turn).error).toBe('cancelado')
  })
})

describe('createModuleLlm', () => {
  it('MODULES_LLM_STUB liga o stub; sem ele, claude-cli com o modelo pedido', async () => {
    const stub = createModuleLlm({ MODULES_LLM_STUB: 'true' }, dir)
    expect(stub).toBeInstanceOf(StubLlmProvider)
    expect((await stub.complete({ prompt: 'x' })).text).toContain('modo stub')

    const real = createModuleLlm({ MODULES_LLM_MODEL: 'sonnet' }, dir)
    expect(real.id).toBe('claude-cli')
    expect(real.model).toBe('sonnet')
  })
})
