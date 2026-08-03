import type { TokenClaims } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import type { SSEEventBus } from '../server/sse.js'
import type { TurnRunner } from '../planning/claude-runner.js'
import { extractJson } from '../planning/json-extract.js'
import type { SprintService } from './sprint.js'
import { loadProjectMetaOrNull } from '../vault/layout.js'
import {
  SprintPlanningSessionStore,
  newSprintPlanningSession,
  isActiveSession,
  type SprintPlanningContext,
  type SprintPlanningSession,
} from '../sprint-planning/session.js'
import {
  SPRINT_STEPS,
  sprintStepById,
  nextSprintStep,
  buildSprintRefinePrompt,
  buildSprintRetryPrompt,
  type SprintStepDef,
} from '../sprint-planning/steps.js'
import { validateFinalSprint } from '../sprint-planning/structure-schema.js'
import type { SprintMaterializer, SprintMaterializeResult } from '../sprint-planning/materialize.js'
import { requirePmOrManager } from './guards.js'
import { requireString } from './validation.js'
import { badRequest, conflict, HttpError } from './errors.js'
import { logger } from '../util/logger.js'

/**
 * Orquestra o wizard de criação de sprint: sessão persistida + turnos headless
 * do claude, uma por projeto (não uma única no servidor todo, como o wizard de
 * projeto). Mesmo contrato assíncrono: answer/refine/retry disparam o turno
 * sem await; o resultado chega por SSE (SPRINT_PLANNING_STEP_READY/_ERROR).
 */
export class SprintPlanningService {
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly paths: Paths,
    private readonly store: SprintPlanningSessionStore,
    private readonly runner: TurnRunner,
    private readonly repo: CardRepository,
    private readonly sse: SSEEventBus,
    private readonly modelLabel: string,
    private readonly sprints: SprintService,
    private readonly materializer: SprintMaterializer,
  ) {}

  async start(params: Record<string, unknown>, claims: TokenClaims): Promise<SprintPlanningSession> {
    requirePmOrManager(claims)
    const project = this.resolveProject(params, claims)
    const meta = await loadProjectMetaOrNull(this.paths, project)
    if (!meta) throw new HttpError(404, { error: 'not_found', project })

    const active = await this.store.listActiveForProject(project)
    if (active[0]) {
      throw conflict({ reason: 'sprint_planning_session_active', session_id: active[0].session_id })
    }

    const context = await this.buildContext(project)
    const first = SPRINT_STEPS[0]!
    const session = newSprintPlanningSession(project, context, first.id)
    if (!first.llm) {
      session.outputs[first.id] = first.staticOutput!(session)
      session.status = 'awaiting_user'
      await this.store.save(session)
      return session
    }
    return this.dispatchTurn(session, first, first.buildPrompt(session), claims)
  }

  async get(params: Record<string, unknown>, claims: TokenClaims): Promise<SprintPlanningSession> {
    requirePmOrManager(claims)
    return this.requireSession(requireString(params, 'session_id'))
  }

  async list(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<{ sessions: SprintPlanningSession[] }> {
    requirePmOrManager(claims)
    // Agente pm só vê o próprio projeto; o manager pode filtrar por `project`
    // ou pedir tudo (sem o param) — mesma convenção de SprintService.listSprints.
    const project =
      claims.role === 'agent'
        ? claims.project_id
        : typeof params['project'] === 'string'
          ? params['project']
          : undefined
    let sessions = (await this.store.list()).filter(isActiveSession)
    if (project) sessions = sessions.filter((s) => s.project === project)
    return { sessions }
  }

  /**
   * Grava a resposta humana da etapa atual e avança para a próxima (todas as
   * etapas deste wizard têm prefill — diferente do KAD, não há etapa estática).
   */
  async answer(params: Record<string, unknown>, claims: TokenClaims): Promise<SprintPlanningSession> {
    requirePmOrManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    const stepId = requireString(params, 'step')
    this.requireAwaiting(session)
    if (stepId !== session.current_step) {
      throw conflict({ reason: 'step_mismatch', current_step: session.current_step })
    }
    const answer = params['answer']
    if (answer === undefined) throw badRequest('invalid_field', { field: 'answer' })

    session.answers[session.current_step] = answer
    if (session.current_step === 'tasks') this.captureTasks(session, answer)

    const next = nextSprintStep(session.current_step)
    if (!next) {
      // review respondida — a sessão fica pronta para o finalize.
      await this.store.save(session)
      return session
    }
    session.current_step = next.id
    return this.dispatchTurn(session, next, next.buildPrompt(session), claims)
  }

  /** Refinamento na mesma etapa (tela confirm/list): não avança o wizard. */
  async refine(params: Record<string, unknown>, claims: TokenClaims): Promise<SprintPlanningSession> {
    requirePmOrManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    const feedback = requireString(params, 'feedback', 4000)
    this.requireAwaiting(session)
    const def = sprintStepById(session.current_step)
    if (!def) throw conflict({ reason: 'unknown_step', step: session.current_step })
    return this.dispatchTurn(session, def, buildSprintRefinePrompt(session, def, feedback), claims)
  }

  /** Re-executa o último turno após um erro (rate-limit, JSON inválido, timeout). */
  async retry(params: Record<string, unknown>, claims: TokenClaims): Promise<SprintPlanningSession> {
    requirePmOrManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    if (session.status !== 'error' || !session.last_prompt) {
      throw conflict({ reason: 'nothing_to_retry', status: session.status })
    }
    const def = sprintStepById(session.current_step)
    if (!def) throw conflict({ reason: 'unknown_step', step: session.current_step })
    return this.dispatchTurn(session, def, session.last_prompt, claims)
  }

  async finalize(
    params: Record<string, unknown>,
    claims: TokenClaims,
  ): Promise<SprintMaterializeResult & { session_id: string }> {
    requirePmOrManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    const resumable = session.status === 'error' && session.materialization !== undefined
    if (session.status !== 'awaiting_user' && !resumable) {
      throw conflict({ reason: 'session_not_ready_to_finalize', status: session.status })
    }
    const output = session.outputs['tasks']
    if (!output?.structure) {
      throw conflict({ reason: 'structure_missing', hint: 'complete a etapa tasks antes' })
    }
    let structure
    try {
      structure = validateFinalSprint(output.structure)
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
        type: 'SPRINT_PLANNING_FINALIZED',
        payload: { session_id: session.session_id, project: result.project, sprint_id: result.sprint_id },
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
    requirePmOrManager(claims)
    const session = await this.requireSession(requireString(params, 'session_id'))
    this.runner.cancel()
    this.inFlight.delete(session.session_id)
    session.status = 'cancelled'
    await this.store.save(session)
    return { session_id: session.session_id, status: session.status }
  }

  // ── Turnos ─────────────────────────────────────────────────────────────────

  private async dispatchTurn(
    session: SprintPlanningSession,
    def: SprintStepDef,
    prompt: string,
    claims: TokenClaims,
  ): Promise<SprintPlanningSession> {
    if (this.inFlight.has(session.session_id)) {
      throw conflict({ reason: 'turn_in_progress', session_id: session.session_id })
    }
    this.inFlight.add(session.session_id)
    session.status = 'generating'
    session.last_error = null
    session.last_prompt = prompt
    await this.store.save(session)

    void this.executeTurn(session, def, prompt, claims.actor).catch((err) => {
      logger.error({ err, session: session.session_id }, 'sprint-planning: turn crashed')
      void this.markError(session, `erro interno: ${(err as Error).message}`, def)
    })
    return session
  }

  private async executeTurn(
    session: SprintPlanningSession,
    def: SprintStepDef,
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
      result = await this.runner.runTurn(buildSprintRetryPrompt(def, parsed.message), session.claude_session_id)
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
    session.status = 'awaiting_user'
    session.last_error = null
    this.inFlight.delete(session.session_id)
    await this.store.save(session)
    this.sse.emit({
      type: 'SPRINT_PLANNING_STEP_READY',
      payload: { session_id: session.session_id, step_id: def.id, status: session.status },
    })
  }

  private tryParse(def: SprintStepDef, text: string): ReturnType<SprintStepDef['parseOutput']> | Error {
    try {
      return def.parseOutput(extractJson(text))
    } catch (err) {
      return err as Error
    }
  }

  private accountTurn(
    session: SprintPlanningSession,
    actor: string,
    r: { usage: { input: number; output: number; usd: number } },
  ): void {
    session.usage.input_tokens += r.usage.input
    session.usage.output_tokens += r.usage.output
    session.usage.usd += r.usage.usd
    session.usage.turns += 1
    if (r.usage.input === 0 && r.usage.output === 0 && r.usage.usd === 0) return
    try {
      this.repo.logTokens({
        ts: new Date().toISOString(),
        op: 'PLANNING',
        card_id: session.session_id,
        card_type: 'sprint_planning',
        actor,
        model: this.modelLabel,
        input_tokens: r.usage.input,
        output_tokens: r.usage.output,
        project: session.project,
        cost_usd: r.usage.usd,
        role: 'wizard',
      })
    } catch (err) {
      logger.warn({ err }, 'sprint-planning: failed to log tokens')
    }
  }

  private async markError(session: SprintPlanningSession, reason: string, def: SprintStepDef): Promise<void> {
    session.status = 'error'
    session.last_error = reason
    this.inFlight.delete(session.session_id)
    await this.store.save(session)
    this.sse.emit({
      type: 'SPRINT_PLANNING_ERROR',
      payload: { session_id: session.session_id, step_id: def.id, reason },
    })
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private resolveProject(params: Record<string, unknown>, claims: TokenClaims): string {
    if (claims.role === 'agent') return claims.project_id
    return requireString(params, 'project')
  }

  private async buildContext(project: string): Promise<SprintPlanningContext> {
    const meta = await loadProjectMetaOrNull(this.paths, project)
    return { target_repo: meta?.target_repo ?? null }
  }

  /**
   * Reconcilia a edição humana da lista de tarefas de volta em
   * outputs['tasks'].structure — sem isso, finalize() só materializaria a
   * proposta original do LLM, nunca a edição do usuário. name/goal não fazem
   * parte desta tela e ficam intocados.
   */
  private captureTasks(session: SprintPlanningSession, answer: unknown): void {
    const existing = session.outputs['tasks']?.structure as { name: string; goal: string } | undefined
    if (!existing) throw conflict({ reason: 'structure_missing', hint: 'complete a etapa tasks antes' })
    if (typeof answer !== 'object' || answer === null) {
      throw badRequest('invalid_field', { field: 'tasks' })
    }
    const tasksRaw = (answer as Record<string, unknown>)['tasks']
    let structure
    try {
      structure = validateFinalSprint({ name: existing.name, goal: existing.goal, tasks: tasksRaw })
    } catch (err) {
      throw badRequest('invalid_field', { field: 'tasks', detail: (err as Error).message })
    }
    session.outputs['tasks'] = { ...session.outputs['tasks']!, structure }
  }

  private requireAwaiting(session: SprintPlanningSession): void {
    if (session.status !== 'awaiting_user') {
      throw conflict({ reason: 'session_not_awaiting_user', status: session.status })
    }
  }

  protected async requireSession(id: string): Promise<SprintPlanningSession> {
    const session = await this.store.load(id)
    if (!session) throw new HttpError(404, { error: 'not_found', session_id: id })
    return session
  }
}
