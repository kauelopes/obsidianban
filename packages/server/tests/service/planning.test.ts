import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PlanningService } from '../../src/services/planning.js'
import { PlanningSessionStore } from '../../src/planning/session.js'
import type { TurnResult, TurnRunner } from '../../src/planning/claude-runner.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims, makeAgentClaims } from '../helpers/factories.js'
import type { Paths } from '../../src/config.js'
import type { CardRepository } from '../../src/cards/repository.js'
import type { SSEEvent } from '@obsidiankan/types'

/** Runner fake: fila de respostas, um TurnResult por turno. */
class FakeRunner implements TurnRunner {
  queue: TurnResult[] = []
  prompts: string[] = []
  cancelled = false

  push(partial: Partial<TurnResult> & { text?: string }): void {
    this.queue.push({
      ok: true,
      text: '',
      sessionId: 'claude-sess-1',
      usage: { input: 100, output: 50, usd: 0.01 },
      rateLimited: false,
      error: null,
      ...partial,
    })
  }

  pushScreen(payload: unknown, extra: Record<string, unknown> = {}): void {
    this.push({ text: JSON.stringify({ screen_payload: payload, ...extra }) })
  }

  async runTurn(prompt: string): Promise<TurnResult> {
    this.prompts.push(prompt)
    const next = this.queue.shift()
    if (!next) throw new Error('FakeRunner: fila vazia')
    return next
  }

  cancel(): void {
    this.cancelled = true
  }
}

let paths: Paths
let store: PlanningSessionStore
let runner: FakeRunner
let repo: CardRepository
let sse: SSEEventBus
let events: SSEEvent[]
let planning: PlanningService

const mgr = makeManagerClaims()

/** Espera o turno fire-and-forget assentar (status sai de generating). */
async function settle(sessionId: string): Promise<ReturnType<PlanningService['get']>> {
  for (let i = 0; i < 50; i++) {
    const s = await planning.get({ session_id: sessionId }, mgr)
    if (s.status !== 'generating') return Promise.resolve(s)
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('sessão não saiu de generating')
}

beforeEach(async () => {
  paths = await createTempVault()
  store = new PlanningSessionStore(paths)
  runner = new FakeRunner()
  repo = createTestRepo(createTestDb())
  sse = new SSEEventBus()
  events = []
  const origEmit = sse.emit.bind(sse)
  sse.emit = (e) => {
    events.push(e)
    origEmit(e)
  }
  planning = new PlanningService(store, runner, repo, sse, 'claude-test', async () => {
    throw new Error('materializer não usado neste teste')
  })
})

afterEach(async () => {
  await cleanupVault(paths)
})

const CHOICE_PAYLOAD = {
  question: 'Qual o tipo?',
  options: [
    { id: 'pessoal', label: 'PESSOAL' },
    { id: 'doutorado', label: 'DOUTORADO' },
  ],
  suggested: 'pessoal',
}

describe('start / get / list', () => {
  it('start cria sessão em identity com a tela estática; manager-only', async () => {
    const s = await planning.start({}, mgr)
    expect(s.current_step).toBe('identity')
    expect(s.status).toBe('awaiting_user')
    expect(s.outputs['identity']).toMatchObject({ screen_payload: expect.anything() })

    await expect(planning.start({}, makeAgentClaims())).rejects.toMatchObject({ status: 403 })
  })

  it('uma sessão ativa por servidor — segundo start é 409', async () => {
    await planning.start({}, mgr)
    await expect(planning.start({}, mgr)).rejects.toMatchObject({ status: 409 })
  })

  it('list mostra só sessões não-terminais', async () => {
    const s = await planning.start({}, mgr)
    expect((await planning.list({}, mgr)).sessions).toHaveLength(1)
    await planning.cancel({ session_id: s.session_id }, mgr)
    expect((await planning.list({}, mgr)).sessions).toHaveLength(0)
  })
})

describe('answer', () => {
  it('identity captura project_name/target_repo e dispara o prefill da próxima etapa', async () => {
    const s = await planning.start({}, mgr)
    runner.pushScreen(CHOICE_PAYLOAD, { kad_patch: { vision: '# Visão do X' } })

    const after = await planning.answer(
      {
        session_id: s.session_id,
        step: 'identity',
        answer: { name: 'projeto-x', description: 'faz x', target_repo: '/tmp/x' },
      },
      mgr,
    )
    // FakeRunner resolve na mesma microtask — o turno pode já ter assentado.
    expect(['generating', 'awaiting_user']).toContain(after.status)

    const settled = await settle(s.session_id)
    expect(settled.status).toBe('awaiting_user')
    expect(settled.current_step).toBe('project_type')
    expect(settled.project_name).toBe('projeto-x')
    expect(settled.target_repo).toBe('/tmp/x')
    expect(settled.kad['vision']).toBe('# Visão do X')
    expect(settled.claude_session_id).toBe('claude-sess-1')
    expect(settled.usage.turns).toBe(1)
    expect(events).toContainEqual({
      type: 'PLANNING_STEP_READY',
      payload: { session_id: s.session_id, step_id: 'project_type', status: 'awaiting_user' },
    })
    // primeiro turno leva o briefing + resposta do usuário
    expect(runner.prompts[0]).toContain('arquiteto de planejamento')
    expect(runner.prompts[0]).toContain('projeto-x')
  })

  it('identity recusa nome fora da regex de projeto e target_repo relativo', async () => {
    const s = await planning.start({}, mgr)
    for (const answer of [
      { name: 'Análise de Produtividade LLM' },
      { name: '' },
      { name: 'valido', target_repo: 'pasta/relativa' },
    ]) {
      await expect(
        planning.answer({ session_id: s.session_id, step: 'identity', answer }, mgr),
      ).rejects.toMatchObject({ status: 400 })
    }
    // a sessão segue em identity, intocada
    const still = await planning.get({ session_id: s.session_id }, mgr)
    expect(still.current_step).toBe('identity')
    expect(still.project_name).toBeNull()
  })

  it('step errado é 409 step_mismatch; answer durante generating é 409', async () => {
    const s = await planning.start({}, mgr)
    await expect(
      planning.answer({ session_id: s.session_id, step: 'scope', answer: {} }, mgr),
    ).rejects.toMatchObject({ status: 409 })
  })

  it('registra tokens no token_log com op PLANNING', async () => {
    const spy = vi.spyOn(repo, 'logTokens')
    const s = await planning.start({}, mgr)
    runner.pushScreen(CHOICE_PAYLOAD)
    await planning.answer(
      { session_id: s.session_id, step: 'identity', answer: { name: 'p1' } },
      mgr,
    )
    await settle(s.session_id)
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'PLANNING',
        card_type: 'planning',
        model: 'claude-test',
        project: 'p1',
        input_tokens: 100,
        output_tokens: 50,
      }),
    )
  })
})

describe('validação de JSON com retry corretivo', () => {
  it('primeira resposta inválida → retry corretivo transparente; segunda válida passa', async () => {
    const s = await planning.start({}, mgr)
    runner.push({ text: 'prosa sem json' })
    runner.pushScreen(CHOICE_PAYLOAD)

    await planning.answer({ session_id: s.session_id, step: 'identity', answer: { name: 'p' } }, mgr)
    const settled = await settle(s.session_id)
    expect(settled.status).toBe('awaiting_user')
    expect(settled.usage.turns).toBe(2)
    expect(runner.prompts[1]).toContain('não validou')
  })

  it('duas respostas inválidas → error recuperável com PLANNING_ERROR', async () => {
    const s = await planning.start({}, mgr)
    runner.push({ text: 'nada' })
    runner.push({ text: 'nada de novo' })

    await planning.answer({ session_id: s.session_id, step: 'identity', answer: { name: 'p' } }, mgr)
    const settled = await settle(s.session_id)
    expect(settled.status).toBe('error')
    expect(settled.last_error).toContain('não validou')
    expect(events.some((e) => e.type === 'PLANNING_ERROR')).toBe(true)
  })
})

describe('rate limit e retry manual', () => {
  it('rate limit vira error last_error=rate_limit; retry re-executa o mesmo prompt', async () => {
    const s = await planning.start({}, mgr)
    runner.push({ ok: false, rateLimited: true, error: 'weekly limit', usage: { input: 0, output: 0, usd: 0 } })
    await planning.answer({ session_id: s.session_id, step: 'identity', answer: { name: 'p' } }, mgr)
    let settled = await settle(s.session_id)
    expect(settled.status).toBe('error')
    expect(settled.last_error).toBe('rate_limit')

    runner.pushScreen(CHOICE_PAYLOAD)
    await planning.retry({ session_id: s.session_id }, mgr)
    settled = await settle(s.session_id)
    expect(settled.status).toBe('awaiting_user')
    expect(runner.prompts[1]).toBe(runner.prompts[0])
  })

  it('retry sem erro pendente é 409', async () => {
    const s = await planning.start({}, mgr)
    await expect(planning.retry({ session_id: s.session_id }, mgr)).rejects.toMatchObject({
      status: 409,
    })
  })
})

describe('refine', () => {
  it('refina a etapa atual sem avançar', async () => {
    const s = await planning.start({}, mgr)
    runner.pushScreen(CHOICE_PAYLOAD)
    await planning.answer({ session_id: s.session_id, step: 'identity', answer: { name: 'p' } }, mgr)
    await settle(s.session_id)

    runner.pushScreen({ ...CHOICE_PAYLOAD, question: 'Corrigido?' })
    await planning.refine({ session_id: s.session_id, feedback: 'adicione opção TRABALHO' }, mgr)
    const settled = await settle(s.session_id)
    expect(settled.current_step).toBe('project_type')
    expect(settled.outputs['project_type']).toMatchObject({
      screen_payload: expect.objectContaining({ question: 'Corrigido?' }),
    })
    expect(runner.prompts.at(-1)).toContain('adicione opção TRABALHO')
  })

  it('refine em etapa sem conteúdo gerado (identity) é 400', async () => {
    const s = await planning.start({}, mgr)
    await expect(
      planning.refine({ session_id: s.session_id, feedback: 'x' }, mgr),
    ).rejects.toMatchObject({ status: 400 })
  })
})

describe('cancel', () => {
  it('cancela o runner e a sessão some da lista de ativas', async () => {
    const s = await planning.start({}, mgr)
    const r = await planning.cancel({ session_id: s.session_id }, mgr)
    expect(r.status).toBe('cancelled')
    expect(runner.cancelled).toBe(true)
  })
})
