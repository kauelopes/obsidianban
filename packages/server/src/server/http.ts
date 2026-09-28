import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type Database from 'better-sqlite3'
import type { TokenValidator } from '../auth/validator.js'
import {
  authenticate,
  isLoopback,
  isPrivateLan,
  readJsonBody,
  rejectUnsafeRequest,
  sendFile,
  sendJson,
} from './http-helpers.js'
import type { IdempotencyStore } from './idempotency.js'
import { isValidRequestId } from './idempotency.js'
import type { SSEEventBus } from './sse.js'
import type { TokenClaims } from '@obsidiankan/types'
import { HttpError } from '../services/errors.js'
import type { MetricsService } from '../services/metrics.js'
import type { TerminalUsageService } from '../services/terminal-usage.js'
import type { ActivityService } from '../services/activity.js'
import type { DigestService } from '../services/digest.js'
import type { FlowService } from '../services/flow.js'
import { ACTIVITY_DAYS_DEFAULT, ACTIVITY_DAYS_MAX, HTTP_SHUTDOWN_TIMEOUT_MS } from '../util/constants.js'
import type { McpHttpManager } from './mcp-http.js'
import type { StaticSite } from './static.js'
import type { SessionToken } from '../auth/session.js'
import type { WorkflowManager } from '../services/workflow-runner.js'
import type { JobManager } from '../services/job-runner.js'
import type { CardRepository } from '../cards/repository.js'
import type { Paths } from '../config.js'
import { listAgentTokens } from '../auth/tokens.js'
import type { WorkflowAgentsStatus, WorkflowInProgressCard } from '@obsidiankan/types'
import { listKadDocs, readKadDoc } from '../vault/kad.js'
import { listRepoDocs, readRepoDoc } from '../vault/repo-docs.js'
import { listSkillFiles, readSkillFile, writeSkillFile } from '../services/skills.js'
import { requireManager, requirePmOrManager } from '../services/guards.js'
import type { ModuleHost } from '../modules/host.js'
import { logger } from '../util/logger.js'

export interface ServerState {
  startedAt: number
  vaultPath: string
  /** true while startup reconciliation is still running */
  reconciling: boolean
  db: Database.Database
}

export interface HttpServerDeps {
  port: number
  host: string
  state: ServerState
  validator: TokenValidator
  idempotency: IdempotencyStore
  sse: SSEEventBus
  metrics: MetricsService
  /** Ingestão sob demanda das sessões de terminal — ausente em testes que não precisam do bloco `terminal`. */
  terminalUsage?: Pick<TerminalUsageService, 'ensureFresh'> | undefined
  activity: ActivityService
  digest: DigestService
  flow: FlowService
  mcp: McpHttpManager
  /** Built web SPA, served from the same origin. Absent when not built. */
  site?: StaticSite | undefined
  /** Ephemeral browser session token, injected into the served index.html. */
  session?: SessionToken | undefined
  /** Execuções do sprint workflow — serve GET /workflow/log e /workflow/agents. */
  workflow?: WorkflowManager | undefined
  /** Cards indexados — serve GET /workflow/agents (cards em andamento na sprint). */
  cardsRepo?: CardRepository | undefined
  /** Necessário para resolver actor → papel (pm/dev) em GET /workflow/agents. */
  paths?: Paths | undefined
  /** Jobs de longa duração — alimenta o campo `jobs` em GET /workflow/agents. */
  jobManager?: Pick<JobManager, 'listRunning'> | undefined
  /** Módulos opcionais — serve /modules e /modules/<id>/... Ausente = sem módulos. */
  modules?: ModuleHost | undefined
}

interface ToolHandler {
  (params: unknown, claims: TokenClaims): Promise<unknown>
}

export class HttpServer {
  private server: http.Server | null = null
  private readonly tools = new Map<string, ToolHandler>()
  // Rastreados para o shutdown poder derrubá-los sem esperar (ver stop()) —
  // server.close() nativo do Node só resolve quando toda conexão aberta
  // termina sozinha, e um stream SSE fica aberto indefinidamente por design.
  private readonly sockets = new Set<Socket>()

  constructor(private readonly deps: HttpServerDeps) {}

  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler)
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.dispatch(req, res).catch((err) => {
        if (err instanceof HttpError) {
          sendJson(res, err.status, err.body)
          return
        }
        sendJson(res, 500, { error: 'internal_error', message: (err as Error).message })
      })
    })
    this.server.on('connection', (socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
    })
    await new Promise<void>((resolve) => this.server!.listen(this.deps.port, this.deps.host, resolve))
  }

  /**
   * Encerra conexões abertas em vez de esperar por elas — um cliente SSE
   * conectado (stream aberto por design) faria o `server.close()` nativo do
   * Node nunca resolver. Fecha os streams SSE de forma limpa primeiro, depois
   * derruba qualquer socket restante (via API nativa quando disponível,
   * senão pelo registro manual de `connection`). Um timeout de segurança
   * garante que o shutdown segue adiante mesmo se algo travar.
   */
  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null

    this.deps.sse.closeAll()

    const closed = new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()))
    })

    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections()
    } else {
      for (const socket of this.sockets) socket.destroy()
    }
    this.sockets.clear()

    await Promise.race([
      closed,
      new Promise<void>((resolve) => setTimeout(resolve, HTTP_SHUTDOWN_TIMEOUT_MS).unref()),
    ])
  }

  getPort(): number | null {
    const addr = this.server?.address()
    if (!addr || typeof addr === 'string') return null
    return addr.port
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? ''

    if (req.method === 'GET' && url === '/health') {
      return this.handleHealth(res)
    }
    if (req.method === 'GET' && url === '/events') {
      return this.handleEvents(req, res)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/metrics') {
      return this.handleMetrics(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/activity') {
      return this.handleActivity(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/flow') {
      return this.handleFlow(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/digest') {
      return this.handleDigest(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/workflow/log') {
      return this.handleWorkflowLog(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/workflow/agents') {
      return this.handleWorkflowAgents(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/vault/kad') {
      return this.handleKadList(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/vault/kad/doc') {
      return this.handleKadDoc(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/vault/repo-docs') {
      return this.handleRepoDocsList(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/vault/repo-docs/doc') {
      return this.handleRepoDoc(req, res, url)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/skills') {
      return this.handleSkillsList(req, res)
    }
    if (req.method === 'GET' && url.split('?')[0] === '/skills/doc') {
      return this.handleSkillDoc(req, res, url)
    }
    if (req.method === 'PUT' && url.split('?')[0] === '/skills/doc') {
      return this.handleSkillDocWrite(req, res)
    }

    const pathname = url.split('?')[0] ?? ''
    if (this.deps.modules && (pathname === '/modules' || pathname.startsWith('/modules/'))) {
      return this.handleModules(req, res, pathname, url, this.deps.modules)
    }

    const toolMatch = /^\/mcp\/tool\/([^/?]+)$/.exec(pathname)
    if (toolMatch && req.method === 'POST') {
      return this.handleToolCall(req, res, toolMatch[1]!)
    }

    if (url.split('?')[0] === '/mcp') {
      return this.handleMcp(req, res)
    }

    // The SPA is served last so it can never shadow an API route. A sessão só
    // acompanha o documento quando ele sai para o loopback — mesmo com HOST=0.0.0.0
    // (acesso via LAN), esse token implícito não é ampliado: qualquer dispositivo
    // na rede que abrisse a página ganharia acesso de manager sem digitar nada.
    // Fora do loopback o fluxo esperado é a TokenGate, com um token real colado.
    if (req.method === 'GET' && this.deps.site) {
      const session = isLoopback(req.socket.remoteAddress ?? '') ? this.deps.session?.raw : null
      return this.deps.site.serve(url, res, session)
    }

    sendJson(res, 404, { error: 'not_found' })
  }

  private handleEvents(req: IncomingMessage, res: ServerResponse): void {
    const lastIdHeader = req.headers['last-event-id']
    const lastId =
      typeof lastIdHeader === 'string' && /^\d+$/.test(lastIdHeader) ? Number(lastIdHeader) : null

    res.statusCode = 200
    res.setHeader('content-type', 'text/event-stream')
    res.setHeader('cache-control', 'no-cache')
    res.setHeader('connection', 'keep-alive')
    res.flushHeaders?.()
    res.write(': open\n\n')

    const unsubscribe = this.deps.sse.subscribe(res, lastId)
    req.on('close', () => unsubscribe())
  }

  private handleHealth(res: ServerResponse): void {
    const { state } = this.deps
    if (state.reconciling) {
      sendJson(res, 503, { status: 'reconciling' })
      return
    }
    const row = state.db.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number }
    sendJson(res, 200, {
      status: 'ok',
      uptime_s: Math.floor((Date.now() - state.startedAt) / 1000),
      vault: state.vaultPath,
      cards_indexed: row.n,
    })
  }

  private async handleMetrics(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    // Rota sem token: a checagem de rede é a única barreira. Permite loopback
    // e a LAN privada em que o servidor pode estar (opcionalmente) exposto
    // via HOST=0.0.0.0, mas nunca a internet pública.
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    // Best-effort: ingestão do terminal falhar (fs indisponível, jsonl
    // corrompido) não pode derrubar o /metrics — o bloco `terminal` da
    // resposta só fica com dado velho, o resto (token_log) segue intacto.
    await this.deps.terminalUsage?.ensureFresh().catch((err) => {
      logger.warn({ err: String(err) }, 'terminal-usage: ensureFresh falhou')
    })
    const params = new URL(url, 'http://localhost').searchParams
    try {
      const metrics = this.deps.metrics.collect({
        from_date: params.get('from_date') ?? undefined,
        to_date: params.get('to_date') ?? undefined,
        card_id: params.get('card_id') ?? undefined,
      })
      sendJson(res, 200, metrics)
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body)
        return
      }
      throw err
    }
  }

  /** Mesma postura do /metrics: rota da SPA local, sem token, loopback ou LAN privada. */
  private async handleActivity(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const days = intParam(params.get('days'), ACTIVITY_DAYS_DEFAULT, 1, ACTIVITY_DAYS_MAX)
    // ±14h cobre todos os fusos reais (UTC-12 a UTC+14).
    const tzOffset = intParam(params.get('tz_offset'), 0, -840, 840)
    if (days === null || tzOffset === null) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'days 1..60, tz_offset -840..840' })
      return
    }
    sendJson(res, 200, await this.deps.activity.collect({ days, tzOffsetMinutes: tzOffset }))
  }

  /**
   * Mesma postura e os mesmos filtros do /metrics — os dois alimentam a mesma
   * aba, e um intervalo que valesse só para metade dela seria armadilha.
   */
  private async handleFlow(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const from = params.get('from_date')
    const to = params.get('to_date')
    for (const [field, value] of [['from_date', from], ['to_date', to]] as const) {
      if (value !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)))) {
        sendJson(res, 400, { error: 'invalid_field', field, expected: 'YYYY-MM-DD' })
        return
      }
    }
    sendJson(res, 200, await this.deps.flow.collect({
      ...(from ? { from_date: from } : {}),
      ...(to ? { to_date: to } : {}),
    }))
  }

  /** Mesma postura do /metrics: rota da SPA local, sem token, loopback ou LAN privada. */
  private async handleDigest(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    // Sem week_start, a semana corrente em UTC. O serviço normaliza qualquer
    // dia para a segunda da sua semana, então o cliente pode mandar "hoje".
    const weekStart = params.get('week_start') ?? new Date().toISOString().slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart) || Number.isNaN(Date.parse(weekStart))) {
      sendJson(res, 400, { error: 'invalid_field', field: 'week_start', expected: 'YYYY-MM-DD' })
      return
    }
    const tzOffset = intParam(params.get('tz_offset'), 0, -840, 840)
    if (tzOffset === null) {
      sendJson(res, 400, { error: 'invalid_field', field: 'tz_offset', expected: '-840..840' })
      return
    }
    sendJson(res, 200, await this.deps.digest.collect({ weekStart, tzOffsetMinutes: tzOffset }))
  }

  /** Mesma postura do /metrics: rota da SPA local, sem token, loopback ou LAN privada. */
  private async handleWorkflowLog(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    if (!this.deps.workflow) {
      sendJson(res, 501, { error: 'not_implemented' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const sprintId = params.get('sprint_id')
    const offset = intParam(params.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
    if (!sprintId || offset === null) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'sprint_id obrigatório, offset >= 0' })
      return
    }
    sendJson(res, 200, await this.deps.workflow.readLog(sprintId, offset))
  }

  /**
   * Visão agregada para o painel de agentes no board: status do processo +
   * fase corrente + cards em andamento (assignee + papel pm/dev, quando
   * resolvível). Mesma postura de /workflow/log: rota da SPA local, sem
   * token, loopback ou LAN privada.
   */
  private async handleWorkflowAgents(
    req: IncomingMessage,
    res: ServerResponse,
    url: string,
  ): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    if (!this.deps.workflow) {
      sendJson(res, 501, { error: 'not_implemented' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const sprintId = params.get('sprint_id')
    if (!sprintId) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'sprint_id obrigatório' })
      return
    }

    const run = this.deps.workflow.status(sprintId)
    const { phase, lastActivityAt, lastTool } = await this.deps.workflow.currentPhase(sprintId)

    let inProgressCards: WorkflowInProgressCard[] = []
    if (this.deps.cardsRepo) {
      const project = run?.project ?? params.get('project')
      const roleByActor = new Map<string, 'pm' | 'dev'>()
      if (project && this.deps.paths) {
        const tokens = await listAgentTokens(this.deps.paths, project).catch(() => [])
        for (const t of tokens) roleByActor.set(t.actor, t.agent_type)
      }
      inProgressCards = this.deps.cardsRepo
        .findBySprint(sprintId)
        .filter((row) => row.status === 'in_progress')
        .map((row) => ({
          id: row.id,
          title: row.title,
          assigned_to: row.assigned_to,
          assigned_role: row.assigned_to ? roleByActor.get(row.assigned_to) ?? null : null,
        }))
    }

    // A rota é escopada por sprint (sprint_id é obrigatório acima), então o
    // campo segue o mesmo escopo: só os jobs running DESTA sprint.
    const jobs =
      this.deps.jobManager?.listRunning().filter((j) => j.sprint_id === sprintId) ?? []

    const body: WorkflowAgentsStatus = {
      sprint_id: sprintId,
      run,
      phase,
      last_activity_at: lastActivityAt,
      in_progress_cards: inProgressCards,
      last_tool: lastTool,
      jobs,
    }
    sendJson(res, 200, body)
  }

  /** Mesma postura do /metrics: rota da SPA local, sem token, loopback ou LAN privada. */
  private async handleKadList(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    if (!this.deps.paths) {
      sendJson(res, 501, { error: 'not_implemented' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const project = params.get('project')
    if (!project) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'project obrigatório' })
      return
    }
    const files = await listKadDocs(this.deps.paths, project)
    sendJson(res, 200, { project, files })
  }

  /** Mesma postura do /metrics: rota da SPA local, sem token, loopback ou LAN privada. */
  private async handleKadDoc(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    if (!this.deps.paths) {
      sendJson(res, 501, { error: 'not_implemented' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const project = params.get('project')
    const doc = params.get('doc')
    if (!project || !doc) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'project e doc obrigatórios' })
      return
    }
    const content = await readKadDoc(this.deps.paths, project, doc)
    if (content === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    sendJson(res, 200, { project, doc, content })
  }

  /** Mesma postura do /metrics: rota da SPA local, sem token, loopback ou LAN privada. */
  private async handleRepoDocsList(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    if (!this.deps.paths) {
      sendJson(res, 501, { error: 'not_implemented' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const project = params.get('project')
    if (!project) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'project obrigatório' })
      return
    }
    const files = await listRepoDocs(this.deps.paths, project)
    sendJson(res, 200, { project, files })
  }

  /** Mesma postura do /metrics: rota da SPA local, sem token, loopback ou LAN privada. */
  private async handleRepoDoc(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const remote = req.socket.remoteAddress ?? ''
    if (!isPrivateLan(remote)) {
      sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
      return
    }
    if (!this.deps.paths) {
      sendJson(res, 501, { error: 'not_implemented' })
      return
    }
    const params = new URL(url, 'http://localhost').searchParams
    const project = params.get('project')
    const doc = params.get('doc')
    if (!project || !doc) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'project e doc obrigatórios' })
      return
    }
    const content = await readRepoDoc(this.deps.paths, project, doc)
    if (content === null) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    sendJson(res, 200, { project, doc, content })
  }

  /**
   * Skills-fonte (.claude/skills/ no monorepo) — a origem única que
   * workflow-readiness replica para cada projeto. Diferente das rotas de
   * vault acima, exige token de manager: é configuração global compartilhada
   * por todo agente de todo projeto, não um documento de leitura per-project.
   */
  private async handleSkillsList(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const claims = await authenticate(this.deps.validator, req, res)
    if (!claims) return
    requireManager(claims)
    sendJson(res, 200, { files: listSkillFiles() })
  }

  private async handleSkillDoc(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    const claims = await authenticate(this.deps.validator, req, res)
    if (!claims) return
    requireManager(claims)
    const params = new URL(url, 'http://localhost').searchParams
    const relPath = params.get('path')
    if (!relPath) {
      sendJson(res, 400, { error: 'invalid_field', hint: 'path obrigatório' })
      return
    }
    const content = await readSkillFile(relPath)
    sendJson(res, 200, { path: relPath, content })
  }

  private async handleSkillDocWrite(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (rejectUnsafeRequest(req, res)) return
    const claims = await authenticate(this.deps.validator, req, res)
    if (!claims) return
    requireManager(claims)
    const body = await readJsonBody(req).catch((_err) => null)
    if (body === null) {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    const params = body as Record<string, unknown>
    const relPath = params['path']
    const content = params['content']
    if (typeof relPath !== 'string' || typeof content !== 'string') {
      sendJson(res, 400, { error: 'invalid_field', hint: 'path e content obrigatórios' })
      return
    }
    await writeSkillFile(relPath, content)
    sendJson(res, 200, { path: relPath, content })
  }

  /**
   * `/modules` e `/modules/<id>` (exatos) são do core: listar e ligar/desligar.
   * Tudo abaixo de `/modules/<id>/` é do módulo, despachado pelo ModuleHost.
   */
  private async handleModules(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    url: string,
    modules: ModuleHost,
  ): Promise<void> {
    if (pathname === '/modules') {
      if (req.method !== 'GET') {
        res.setHeader('allow', 'GET')
        sendJson(res, 405, { error: 'method_not_allowed' })
        return
      }
      const claims = await authenticate(this.deps.validator, req, res)
      if (!claims) return
      sendJson(res, 200, { modules: modules.list() })
      return
    }

    const m = /^\/modules\/([^/]+)(\/.*)?$/.exec(pathname)
    if (!m) {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    const id = m[1]!
    const subpath = m[2]

    if (subpath === undefined) {
      if (req.method === 'GET') {
        const claims = await authenticate(this.deps.validator, req, res)
        if (!claims) return
        const info = modules.get(id)
        if (!info) sendJson(res, 404, { error: 'not_found' })
        else sendJson(res, 200, info)
        return
      }
      if (req.method !== 'PUT') {
        res.setHeader('allow', 'GET, PUT')
        sendJson(res, 405, { error: 'method_not_allowed' })
        return
      }
      if (rejectUnsafeRequest(req, res)) return
      const claims = await authenticate(this.deps.validator, req, res)
      if (!claims) return
      requireManager(claims)
      const body = await readJsonBody(req).catch((_err) => null)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        sendJson(res, 400, { error: 'invalid_json' })
        return
      }
      const { enabled, config } = body as Record<string, unknown>
      if (enabled !== undefined && typeof enabled !== 'boolean') {
        sendJson(res, 400, { error: 'invalid_field', field: 'enabled', expected: 'boolean' })
        return
      }
      if (config !== undefined && (typeof config !== 'object' || config === null || Array.isArray(config))) {
        sendJson(res, 400, { error: 'invalid_field', field: 'config', expected: 'object' })
        return
      }
      const info = await modules.update(id, {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(config !== undefined ? { config: config as Record<string, unknown> } : {}),
      })
      if (!info) sendJson(res, 404, { error: 'not_found' })
      else sendJson(res, 200, info)
      return
    }

    const match = modules.match(id, req.method ?? '', subpath)
    if (match.kind === 'not_found') {
      sendJson(res, 404, { error: 'not_found' })
      return
    }
    if (match.kind === 'method_not_allowed') {
      res.setHeader('allow', match.allow.join(', '))
      sendJson(res, 405, { error: 'method_not_allowed' })
      return
    }

    const { route, params } = match
    const mutating = route.method !== 'GET'
    if (mutating && rejectUnsafeRequest(req, res)) return

    let claims: TokenClaims | null = null
    if (route.auth === 'lan') {
      if (!isPrivateLan(req.socket.remoteAddress ?? '')) {
        sendJson(res, 403, { error: 'forbidden', reason: 'localhost_only' })
        return
      }
    } else {
      claims = await authenticate(this.deps.validator, req, res)
      if (!claims) return
      if (route.auth === 'pm') requirePmOrManager(claims)
      if (route.auth === 'manager') requireManager(claims)
    }

    let body: unknown = undefined
    if (route.method === 'POST' || route.method === 'PUT') {
      body = await readJsonBody(req).catch((_err) => null)
      if (body === null) {
        sendJson(res, 400, { error: 'invalid_json' })
        return
      }
    }

    let out
    try {
      out = await route.handler({
        method: route.method,
        path: subpath,
        params,
        query: new URL(url, 'http://localhost').searchParams,
        body,
        claims,
      })
    } catch (err) {
      const e = err as { status?: unknown; body?: unknown }
      if (typeof e?.status === 'number' && typeof e.body === 'object' && e.body !== null) {
        sendJson(res, e.status, e.body)
        return
      }
      logger.error({ err, module: id, route: `${route.method} ${route.pattern}` }, 'modules: handler lançou')
      sendJson(res, 500, { error: 'internal_error', module: id })
      return
    }
    if ('file' in out) {
      sendFile(res, out.status ?? 200, out.file.data, out.file.contentType, out.file.filename)
    } else {
      sendJson(res, out.status ?? 200, out.json)
    }
  }

  private async handleToolCall(
    req: IncomingMessage,
    res: ServerResponse,
    toolName: string,
  ): Promise<void> {
    if (rejectUnsafeRequest(req, res)) return

    const claims = await authenticate(this.deps.validator, req, res)
    if (!claims) return

    const body = await readJsonBody(req).catch((_err) => null)
    if (body === null) {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    const params = body as Record<string, unknown>
    const requestId = typeof params['request_id'] === 'string' ? params['request_id'] : undefined
    if (requestId !== undefined && !isValidRequestId(requestId)) {
      sendJson(res, 400, { error: 'invalid_request_id' })
      return
    }

    if (requestId) {
      const cached = this.deps.idempotency.get(requestId)
      if (cached) {
        sendJson(res, 200, cached.response)
        return
      }
    }

    const handler = this.tools.get(toolName)
    if (!handler) {
      sendJson(res, 501, { error: 'not_implemented', tool: toolName })
      return
    }

    try {
      const response = await handler(params, claims)
      if (requestId) await this.deps.idempotency.put(requestId, response)
      sendJson(res, 200, response)
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, err.body)
        return
      }
      throw err
    }
  }

  private async handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Stateless Streamable HTTP: the client drives everything over POST. There
    // is no server-initiated stream to open, so GET/DELETE are not supported.
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, {
        error: 'method_not_allowed',
        hint: 'the /mcp endpoint is stateless Streamable HTTP — use POST',
      })
      return
    }
    if (rejectUnsafeRequest(req, res)) return

    const claims = await authenticate(this.deps.validator, req, res)
    if (!claims) return
    const body = await readJsonBody(req).catch((_err) => null)
    if (body === null) {
      sendJson(res, 400, { error: 'invalid_json' })
      return
    }
    await this.deps.mcp.handleRequest(req, res, claims, body)
  }
}

/** Inteiro do querystring dentro de [min, max]; ausente vira fallback, inválido vira null. */
function intParam(raw: string | null, fallback: number, min: number, max: number): number | null {
  if (raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) return null
  return n
}
