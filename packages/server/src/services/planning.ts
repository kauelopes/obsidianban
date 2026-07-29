import type { TokenClaims } from '@obsidiankan/types'
import type { CardRepository } from '../cards/repository.js'
import type { SSEEventBus } from '../server/sse.js'
import type { TurnRunner } from '../planning/claude-runner.js'
import {
  PlanningSessionStore,
  newPlanningSession,
  isActiveSession,
  type PlanningSession,
} from '../planning/session.js'
import {
  STEPS,
  stepById,
  nextStep,
  buildRefinePrompt,
  buildRetryPrompt,
  type StepDef,
} from '../planning/steps.js'
import { extractJson } from '../planning/json-extract.js'
import { validateFinalStructure } from '../planning/structure-schema.js'
import type { Materializer, MaterializeResult } from '../planning/materialize.js'
import { requireManager } from './guards.js'
import { requireString } from './validation.js'
import { badRequest, conflict, HttpError } from './errors.js'
import { logger } from '../util/logger.js'
import path from 'node:path'

const SAFE_PROJECT = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/**
 * Orquestra o wizard de planejamento: sessão persistida + turnos headless do
 * claude. Os turnos levam 30s–3min, muito além do timeout do client web, então
 * answer/refine/retry disparam o turno SEM await e retornam já — o resultado
 * chega por SSE (PLANNING_STEP_READY/PLANNING_ERROR) com planning_get de
 * polling como fallback.
 */
export class PlanningService {
  /** Sessões com turno em voo neste processo — barreira além do status persistido. */
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly store: PlanningSessionStore,
    private readonly runner: TurnRunner,
    private readonly repo: CardRepository,
    private readonly sse: SSEEventBus,
    /** Rótulo de modelo para o token_log — o custo real (usd) vem do harness. */
    private readonly modelLabel: string,
    private readonly materializer: Materializer,
  ) {}

  async start(_params: Record<string, unknown>, claims: TokenClaims): Promise<PlanningSession> {
    requireManager(claims)
    const active = (await this.store.list()).find(isActiveSession)
    if (active) {
      throw conflict({ reason: 'planning_session_active', session_id: active.session_id })
    }
    const first = STEPS[0]!
    const session = newPlanningSession(first.id)
    session.outputs[first.id] = { screen_payload: first.staticPayload }
    await this.store.save(session)
    return session
  }

  async get(params: Record<string, unknown>, claims: TokenClaims): Promise<PlanningSession> {
    requireManager(claims)
    return this.requireSession(requireString(params, 'session_id'))
  }

  async list(
    _params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ sessions: PlanningSession[] }> {
    requireManager(claims)
    const sessions = (await this.store.list()).filter(isActiveSession)
    return { sessions }
  }

  /**
   * Grava a resposta humana da etapa atual e avança: a próxima etapa com
   * prefill dispara um turno; sem prefill (ou sem próxima etapa) a sessão
   * volta direto para awaiting_user.
   */
  async answer(params: Record<string, unknown>, claims: TokenClaims): Promise<PlanningSession> {
    requireManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    const stepId = requireString(params, 'step')
    this.requireAwaiting(session)
    if (stepId !== session.current_step) {
      throw conflict({ reason: 'step_mismatch', current_step: session.current_step })
    }
    const answer = params['answer']
    if (answer === undefined) throw badRequest('invalid_field', { field: 'answer' })

    session.answers[session.current_step] = answer
    if (session.current_step === 'identity') this.captureIdentity(session, answer)

    const next = nextStep(session.current_step)
    if (!next) {
      // review respondida — a sessão fica pronta para o finalize.
      await this.store.save(session)
      return session
    }

    session.current_step = next.id
    if (!next.prefill) {
      session.outputs[next.id] = { screen_payload: next.staticPayload }
      await this.store.save(session)
      return session
    }
    return this.dispatchTurn(session, next, next.buildPrompt(session), claims)
  }

  /** Refinamento na mesma etapa (telas diagram/confirm): não avança o wizard. */
  async refine(params: Record<string, unknown>, claims: TokenClaims): Promise<PlanningSession> {
    requireManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    const feedback = requireString(params, 'feedback', 4000)
    this.requireAwaiting(session)
    const def = stepById(session.current_step)
    if (!def || !def.prefill) {
      throw badRequest('invalid_field', {
        field: 'session_id',
        reason: 'current step has no generated content to refine',
      })
    }
    return this.dispatchTurn(session, def, buildRefinePrompt(session, def, feedback), claims)
  }

  /** Re-executa o último turno após um erro (rate-limit, JSON inválido, timeout). */
  async retry(params: Record<string, unknown>, claims: TokenClaims): Promise<PlanningSession> {
    requireManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    if (session.status !== 'error' || !session.last_prompt) {
      throw conflict({ reason: 'nothing_to_retry', status: session.status })
    }
    const def = stepById(session.current_step)
    if (!def) throw conflict({ reason: 'unknown_step', step: session.current_step })
    return this.dispatchTurn(session, def, session.last_prompt, claims)
  }

  /**
   * Materialização síncrona: a estrutura já está pronta (etapa sprints_tasks),
   * só há escrita de servidor — cabe no timeout do client. Cada fase grava
   * checkpoint na sessão; após uma falha, re-chamar retoma de onde parou.
   */
  async finalize(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<MaterializeResult & { session_id: string }> {
    requireManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    const resumable = session.status === 'error' && session.materialization !== undefined
    if (session.status !== 'awaiting_user' && !resumable) {
      throw conflict({ reason: 'session_not_ready_to_finalize', status: session.status })
    }
    const output = session.outputs['sprints_tasks'] as { structure?: unknown } | undefined
    if (!output?.structure) {
      throw conflict({ reason: 'structure_missing', hint: 'complete a etapa sprints_tasks antes' })
    }
    let structure
    try {
      structure = validateFinalStructure(output.structure)
    } catch (err) {
      throw badRequest('invalid_structure', { detail: (err as Error).message })
    }

    session.status = 'materializing'
    await this.store.save(session)
    try {
      const result = await this.materializer(session, structure, claims)
      session.status = 'done'
      session.last_error = null
      await this.store.save(session)
      this.sse.emit({
        type: 'PLANNING_FINALIZED',
        payload: { session_id: session.session_id, project: result.project },
      })
      return { session_id: session.session_id, ...result }
    } catch (err) {
      session.status = 'error'
      session.last_error = `materialização falhou: ${(err as Error).message}`
      await this.store.save(session)
      throw err
    }
  }

  async cancel(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ session_id: string; status: string }> {
    requireManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    this.runner.cancel()
    this.inFlight.delete(session.session_id)
    session.status = 'cancelled'
    await this.store.save(session)
    return { session_id: session.session_id, status: session.status }
  }

  // ── Turnos ─────────────────────────────────────────────────────────────────

  private async dispatchTurn(
    session: PlanningSession,
    def: StepDef,
    prompt: string,
    claims: TokenClaims,
  ): Promise<PlanningSession> {
    if (this.inFlight.has(session.session_id)) {
      throw conflict({ reason: 'turn_in_progress', session_id: session.session_id })
    }
    this.inFlight.add(session.session_id)
    session.status = 'generating'
    session.last_error = null
    session.last_prompt = prompt
    await this.store.save(session)

    void this.executeTurn(session, def, prompt, claims.actor).catch((err) => {
      logger.error({ err, session: session.session_id }, 'planning: turn crashed')
      void this.markError(session, `erro interno: ${(err as Error).message}`, def)
    })
    return session
  }

  private async executeTurn(
    session: PlanningSession,
    def: StepDef,
    prompt: string,
    actor: string,
  ): Promise<void> {
    let result = await this.runner.runTurn(prompt, session.claude_session_id)
    this.accountTurn(session, actor, result)
    if (!result.ok) {
      await this.markError(session, result.rateLimited ? 'rate_limit' : (result.error ?? 'turno falhou'), def)
      return
    }
    if (result.sessionId) session.claude_session_id = result.sessionId

    let parsed = this.tryParse(def, result.text)
    if (parsed instanceof Error) {
      // Um retry corretivo na mesma sessão: o modelo vê o próprio erro.
      result = await this.runner.runTurn(buildRetryPrompt(def, parsed.message), session.claude_session_id)
      this.accountTurn(session, actor, result)
      if (!result.ok) {
        await this.markError(session, result.rateLimited ? 'rate_limit' : (result.error ?? 'turno falhou'), def)
        return
      }
      if (result.sessionId) session.claude_session_id = result.sessionId
      parsed = this.tryParse(def, result.text)
      if (parsed instanceof Error) {
        await this.markError(session, `resposta do modelo não validou: ${parsed.message}`, def)
        return
      }
    }

    session.outputs[def.id] = {
      screen_payload: parsed.screen_payload,
      ...(parsed.structure !== undefined ? { structure: parsed.structure } : {}),
    }
    for (const [doc, md] of Object.entries(parsed.kad_patch ?? {})) {
      session.kad[doc as keyof PlanningSession['kad']] = md
    }
    session.status = 'awaiting_user'
    session.last_error = null
    this.inFlight.delete(session.session_id)
    await this.store.save(session)
    this.sse.emit({
      type: 'PLANNING_STEP_READY',
      payload: { session_id: session.session_id, step_id: def.id, status: session.status },
    })
  }

  private tryParse(def: StepDef, text: string): ReturnType<StepDef['parseOutput']> | Error {
    try {
      return def.parseOutput(extractJson(text))
    } catch (err) {
      return err as Error
    }
  }

  private accountTurn(
    session: PlanningSession,
    actor: string,
    r: { usage: { input: number; output: number; usd: number } },
  ): void {
    session.usage.input_tokens += r.usage.input
    session.usage.output_tokens += r.usage.output
    session.usage.usd += r.usage.usd
    session.usage.turns += 1
    // usd entra no guard: um turno todo servido de cache tem input/output 0
    // mas custo real — descartá-lo perderia exatamente a medição autoritativa.
    if (r.usage.input === 0 && r.usage.output === 0 && r.usage.usd === 0) return
    try {
      this.repo.logTokens({
        ts: new Date().toISOString(),
        op: 'PLANNING',
        card_id: session.session_id,
        card_type: 'planning',
        actor,
        model: this.modelLabel,
        input_tokens: r.usage.input,
        output_tokens: r.usage.output,
        project: session.project_name ?? 'planejamento',
        cost_usd: r.usage.usd,
      })
    } catch (err) {
      logger.warn({ err }, 'planning: failed to log tokens')
    }
  }

  private async markError(session: PlanningSession, reason: string, def: StepDef): Promise<void> {
    session.status = 'error'
    session.last_error = reason
    this.inFlight.delete(session.session_id)
    await this.store.save(session)
    this.sse.emit({
      type: 'PLANNING_ERROR',
      payload: { session_id: session.session_id, step_id: def.id, reason },
    })
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  // Valida aqui, na primeira etapa, o que a materialização exigiria 14 etapas
  // (e vários dólares) depois: nome dentro da regex de projeto e repo absoluto.
  private captureIdentity(session: PlanningSession, answer: unknown): void {
    if (typeof answer !== 'object' || answer === null) {
      throw badRequest('invalid_field', { field: 'answer', expected: 'object with name' })
    }
    const a = answer as Record<string, unknown>
    if (typeof a['name'] !== 'string' || !SAFE_PROJECT.test(a['name'])) {
      throw badRequest('invalid_field', {
        field: 'answer.name',
        expected: '[a-zA-Z0-9][a-zA-Z0-9._-]{0,63} — letras, números, pontos, hífens; sem espaços ou acentos',
      })
    }
    const repo = typeof a['target_repo'] === 'string' && a['target_repo'] !== '' ? a['target_repo'] : null
    if (repo !== null && !path.isAbsolute(repo)) {
      throw badRequest('invalid_field', {
        field: 'answer.target_repo',
        expected: 'caminho absoluto (ou vazio)',
      })
    }
    session.project_name = a['name']
    session.target_repo = repo
  }

  private requireAwaiting(session: PlanningSession): void {
    if (session.status !== 'awaiting_user') {
      throw conflict({ reason: 'session_not_awaiting_user', status: session.status })
    }
  }

  protected async requireSession(id: string): Promise<PlanningSession> {
    const session = await this.store.load(id)
    if (!session) throw new HttpError(404, { error: 'not_found', session_id: id })
    return session
  }
}
