import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { HttpServer } from '../../src/server/http.js'
import { loadProjectMeta, saveProjectMeta } from '../../src/vault/layout.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { IdempotencyStore } from '../../src/server/idempotency.js'
import { TokenValidator } from '../../src/auth/validator.js'
import { MetricsService } from '../../src/services/metrics.js'
import { ActivityService } from '../../src/services/activity.js'
import { GitActivityService } from '../../src/services/git-activity.js'
import { CardService } from '../../src/services/card.js'
import { SprintService } from '../../src/services/sprint.js'
import { HistoryService } from '../../src/services/history.js'
import { SupervisionService } from '../../src/services/supervision.js'
import { DigestService } from '../../src/services/digest.js'
import { FlowService } from '../../src/services/flow.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { createAgentToken, createManagerToken, revokeAgentToken } from '../../src/auth/tokens.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims } from '../helpers/factories.js'
import { httpPost, httpGet } from '../helpers/http.js'
import type { McpHttpManager } from '../../src/server/mcp-http.js'
import { WorkflowManager } from '../../src/services/workflow-runner.js'
import { JobStore } from '../../src/jobs/store.js'
import { JobManager } from '../../src/services/job-runner.js'
import { HTTP_SHUTDOWN_TIMEOUT_MS } from '../../src/util/constants.js'

let paths: Paths
let server: HttpServer
let port: number
let pmTokenRaw: string
let devTokenRaw: string
let sprintId: string
let jobManager: JobManager

const TOKEN = { input_tokens: 0, output_tokens: 0, model: 'test' }

beforeAll(async () => {
  paths = await createTempVault()
  const db = createTestDb()
  const repo = createTestRepo(db)
  const writer = new AtomicWriter(paths, repo)
  const audit = new AuditLogger(paths.auditLog)
  const sse = new SSEEventBus()
  const validator = new TokenValidator(paths)
  const idempotency = new IdempotencyStore(paths.idempotencyStore)
  await idempotency.load()
  const metrics = new MetricsService(db)

  await setupTestProject(paths, 'test-project')
  const pmIssued = await createAgentToken(paths, 'test-project', 'agent:pm', 'pm')
  const devIssued = await createAgentToken(paths, 'test-project', 'agent:dev', 'dev')
  pmTokenRaw = pmIssued.raw
  devTokenRaw = devIssued.raw

  const cardService = new CardService(paths, repo, writer, audit, sse)
  const sprintService = new SprintService(paths, repo, writer, audit, sse)
  const historyService = new HistoryService(paths)
  const supervisionService = new SupervisionService(paths, repo)

  // Create and activate a sprint so card creation has a valid sprint_id
  const mgr = makeManagerClaims()
  const sprint = await sprintService.createSprint({ project: 'test-project', name: 'S1' }, mgr)
  await sprintService.startSprint({ sprint_id: sprint.id }, mgr)
  sprintId = sprint.id

  // Stub McpHttpManager — integration tests only use /mcp/tool/:name
  const mcpStub = { handleRequest: vi.fn().mockResolvedValue(undefined) } as unknown as McpHttpManager

  const state = {
    startedAt: Date.now(),
    vaultPath: paths.vault,
    reconciling: false,
    db,
  }

  const activity = new ActivityService(db, paths, new GitActivityService())
  // WorkflowManager real, mas sem spawn: a rota /workflow/log só lê o disco.
  const wfLogDir = path.join(paths.vault, '.kanban', 'workflow-logs')
  await fs.mkdir(wfLogDir, { recursive: true })
  await fs.writeFile(path.join(wfLogDir, 'sprint-wf1.log'), 'linha um\nlinha dois\n', 'utf8')
  const workflow = new WorkflowManager(
    { scriptPath: '/nonexistent.mjs', logDir: wfLogDir, autoLaunch: false, kanbanUrl: 'http://127.0.0.1:0' },
    sse,
    paths,
  )
  jobManager = new JobManager(
    {
      logDir: path.join(paths.vault, '.kanban', 'job-logs'),
      stallThresholdMs: 60_000,
      stallPollMs: 60_000,
      maxRuntimeMs: 60_000,
      maxConcurrent: 3,
      envAllowlist: [],
      maxWakesPerSprint: 5,
    },
    new JobStore(paths),
    cardService,
    sse,
    audit,
    workflow,
    paths,
  )
  server = new HttpServer({
    port: 0,
    host: '127.0.0.1',
    state,
    validator,
    idempotency,
    sse,
    metrics,
    activity,
    digest: new DigestService(paths, repo, metrics, activity, supervisionService),
    flow: new FlowService(paths, metrics),
    mcp: mcpStub,
    workflow,
    cardsRepo: repo,
    paths,
    jobManager,
  })

  server.registerTool('kanban_create_card', (p, c) =>
    cardService.create(p as Record<string, unknown>, c),
  )
  server.registerTool('kanban_get_card', (p, c) =>
    cardService.get(p as Record<string, unknown>, c),
  )
  server.registerTool('kanban_create_sprint', (p, c) =>
    sprintService.createSprint(p as Record<string, unknown>, c),
  )
  server.registerTool('kanban_log_on_card', (p, c) =>
    cardService.logOnCard(p as Record<string, unknown>, c),
  )
  server.registerTool('kanban_move_card', (p, c) => cardService.move(p as Record<string, unknown>, c))
  server.registerTool('kanban_get_card_history', (p, c) =>
    historyService.getCardHistory(p as Record<string, unknown>, c),
  )
  server.registerTool('kanban_list_escalations', (p, c) =>
    supervisionService.listEscalations(p as Record<string, unknown>, c),
  )

  await server.start()
  port = server.getPort()!
})

afterAll(async () => {
  await jobManager.dispose()
  await server.stop()
  await cleanupVault(paths)
})

describe('GET /health', () => {
  it('returns 200 with status ok when not reconciling', async () => {
    const res = await httpGet(port, '/health')
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>)['status']).toBe('ok')
    expect(typeof (res.body as Record<string, unknown>)['cards_indexed']).toBe('number')
  })
})

describe('POST /mcp/tool/kanban_create_card — happy path', () => {
  it('creates a card and returns it in the response', async () => {
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'Integration Card', type: 'task', sprint_id: sprintId, ...TOKEN },
      pmTokenRaw,
    )
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(typeof body['id']).toBe('string')
    expect(body['title']).toBe('Integration Card')
  })

  it('created card .md file exists on disk', async () => {
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'File Check Card', type: 'bug', sprint_id: sprintId, ...TOKEN },
      pmTokenRaw,
    )
    const body = res.body as Record<string, unknown>
    const basename = body['file_basename'] as string
    const filePath = path.join(paths.kanbanData, 'test-project', `${basename}.md`)
    await expect(fs.stat(filePath)).resolves.toBeDefined()
  })
})

describe('POST /mcp/tool/kanban_get_card', () => {
  it('returns card with body from disk', async () => {
    const createRes = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'Get Card Test', type: 'feature', sprint_id: sprintId, body: 'card body text', ...TOKEN },
      pmTokenRaw,
    )
    const cardId = (createRes.body as Record<string, unknown>)['id'] as string

    const getRes = await httpGet(port, `/mcp/tool/kanban_get_card?id=${cardId}`)
    // GET on a POST route returns 404 — use POST
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_get_card',
      { id: cardId },
      pmTokenRaw,
    )
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>)['body']).toContain('card body text')
    void getRes
  })
})

describe('idempotency', () => {
  it('second request with same request_id returns identical response without creating a duplicate', async () => {
    const requestId = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789'
    const payload = {
      title: 'Idempotent Card',
      type: 'task',
      sprint_id: sprintId,
      request_id: requestId,
      ...TOKEN,
    }

    const first = await httpPost(port, '/mcp/tool/kanban_create_card', payload, pmTokenRaw)
    expect(first.status).toBe(200)

    const second = await httpPost(port, '/mcp/tool/kanban_create_card', payload, pmTokenRaw)
    expect(second.status).toBe(200)
    expect((second.body as Record<string, unknown>)['id']).toBe(
      (first.body as Record<string, unknown>)['id'],
    )
  })
})

describe('authentication', () => {
  it('missing Authorization header returns 401 missing_token', async () => {
    const res = await httpPost(port, '/mcp/tool/kanban_create_card', { title: 'x' })
    expect(res.status).toBe(401)
    expect((res.body as Record<string, unknown>)['error']).toBe('missing_token')
  })

  it('invalid token returns 401 invalid_token', async () => {
    const res = await httpPost(port, '/mcp/tool/kanban_create_card', { title: 'x' }, 'garbage-token')
    expect(res.status).toBe(401)
    expect((res.body as Record<string, unknown>)['error']).toBe('invalid_token')
  })

  it('revoked token returns 401 revoked_token', async () => {
    const issued = await createAgentToken(paths, 'test-project', 'agent:temp', 'pm')
    // Create a new token validator that picks up the revoked state
    await revokeAgentToken(paths, 'test-project', issued.token_id)
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'x' },
      issued.raw,
    )
    expect(res.status).toBe(401)
    expect((res.body as Record<string, unknown>)['error']).toBe('revoked_token')
  })
})

describe('access control', () => {
  it('dev agent calling kanban_create_sprint returns 403', async () => {
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_create_sprint',
      { name: 'New Sprint', project: 'test-project' },
      devTokenRaw,
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /mcp/tool/kanban_get_card_history', () => {
  it('returns the audit trail of a card, newest first', async () => {
    const created = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'History Card', type: 'task', sprint_id: sprintId, ...TOKEN },
      pmTokenRaw,
    )
    const card = created.body as Record<string, unknown>

    await httpPost(
      port,
      '/mcp/tool/kanban_log_on_card',
      { id: card['id'], version: card['version'], log_entry: 'first step done', ...TOKEN },
      pmTokenRaw,
    )

    const res = await httpPost(
      port,
      '/mcp/tool/kanban_get_card_history',
      { id: card['id'] },
      pmTokenRaw,
    )
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(body['card_id']).toBe(card['id'])
    const entries = body['entries'] as Array<Record<string, unknown>>
    expect(entries.map((e) => e['op'])).toEqual(['UPDATE', 'CREATE'])
    expect(body['truncated']).toBe(false)
  })

  it('honours limit and reports truncation', async () => {
    const created = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'Truncation Card', type: 'task', sprint_id: sprintId, ...TOKEN },
      pmTokenRaw,
    )
    const card = created.body as Record<string, unknown>
    await httpPost(
      port,
      '/mcp/tool/kanban_log_on_card',
      { id: card['id'], version: card['version'], log_entry: 'entry', ...TOKEN },
      pmTokenRaw,
    )

    const res = await httpPost(
      port,
      '/mcp/tool/kanban_get_card_history',
      { id: card['id'], limit: 1 },
      pmTokenRaw,
    )
    const body = res.body as Record<string, unknown>
    expect((body['entries'] as unknown[]).length).toBe(1)
    expect(body['truncated']).toBe(true)
  })

  it('unknown card id returns an empty history, not an error', async () => {
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_get_card_history',
      { id: 'card-doesnotexist' },
      pmTokenRaw,
    )
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>)['entries']).toEqual([])
  })

  it('dev agent returns 403', async () => {
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_get_card_history',
      { id: 'card-anything' },
      devTokenRaw,
    )
    expect(res.status).toBe(403)
  })
})

describe('POST /mcp/tool/kanban_list_escalations', () => {
  it('lists a card moved to review, and drops it once moved off review', async () => {
    const created = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'Escalated Card', type: 'task', sprint_id: sprintId, ...TOKEN },
      pmTokenRaw,
    )
    const card = created.body as Record<string, unknown>

    const logged = await httpPost(
      port,
      '/mcp/tool/kanban_log_on_card',
      {
        id: card['id'],
        version: card['version'],
        log_entry: 'schema migration needs a call: drop or backfill?',
        log_kind: 'escalate',
        ...TOKEN,
      },
      pmTokenRaw,
    )
    expect(logged.status).toBe(200)

    const moved = await httpPost(
      port,
      '/mcp/tool/kanban_move_card',
      {
        id: card['id'],
        version: (logged.body as Record<string, unknown>)['version'],
        to_status: 'review',
        ...TOKEN,
      },
      pmTokenRaw,
    )
    expect(moved.status).toBe(200)

    const res = await httpPost(port, '/mcp/tool/kanban_list_escalations', {}, pmTokenRaw)
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    expect(typeof body['scanned']).toBe('number')
    const items = body['escalations'] as Array<Record<string, unknown>>
    const mine = items.find((e) => e['card_id'] === card['id'])
    expect(mine).toBeDefined()
    expect(mine!['reason']).toContain('drop or backfill')
    expect(mine!['title']).toBe('Escalated Card')

    // Logging pm_resolved alone does NOT remove it — only leaving 'review' does,
    // since the criterion is status, not the log's last explicit kind.
    const resolved = await httpPost(
      port,
      '/mcp/tool/kanban_log_on_card',
      {
        id: card['id'],
        version: (moved.body as Record<string, unknown>)['version'],
        log_entry: 'decided: backfill',
        log_kind: 'pm_resolved',
        ...TOKEN,
      },
      pmTokenRaw,
    )
    const stillThere = await httpPost(port, '/mcp/tool/kanban_list_escalations', {}, pmTokenRaw)
    const stillItems = (stillThere.body as Record<string, unknown>)['escalations'] as Array<
      Record<string, unknown>
    >
    expect(stillItems.find((e) => e['card_id'] === card['id'])).toBeDefined()

    await httpPost(
      port,
      '/mcp/tool/kanban_move_card',
      {
        id: card['id'],
        version: (resolved.body as Record<string, unknown>)['version'],
        to_status: 'todo',
        ...TOKEN,
      },
      pmTokenRaw,
    )

    const after = await httpPost(port, '/mcp/tool/kanban_list_escalations', {}, pmTokenRaw)
    const remaining = (after.body as Record<string, unknown>)['escalations'] as Array<
      Record<string, unknown>
    >
    expect(remaining.find((e) => e['card_id'] === card['id'])).toBeUndefined()
  })

  it('lists a review card even without an explicit escalate-tagged log entry', async () => {
    const created = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'Plain Review Card', type: 'task', sprint_id: sprintId, ...TOKEN },
      pmTokenRaw,
    )
    const card = created.body as Record<string, unknown>

    const logged = await httpPost(
      port,
      '/mcp/tool/kanban_log_on_card',
      { id: card['id'], version: card['version'], log_entry: 'wrapped up, needs a look', ...TOKEN },
      pmTokenRaw,
    )

    const moved = await httpPost(
      port,
      '/mcp/tool/kanban_move_card',
      {
        id: card['id'],
        version: (logged.body as Record<string, unknown>)['version'],
        to_status: 'review',
        ...TOKEN,
      },
      pmTokenRaw,
    )
    expect(moved.status).toBe(200)

    const res = await httpPost(port, '/mcp/tool/kanban_list_escalations', {}, pmTokenRaw)
    const items = (res.body as Record<string, unknown>)['escalations'] as Array<
      Record<string, unknown>
    >
    const mine = items.find((e) => e['card_id'] === card['id'])
    expect(mine).toBeDefined()
    expect(mine!['reason']).toContain('wrapped up, needs a look')
  })

  it('dev agent returns 403', async () => {
    const res = await httpPost(port, '/mcp/tool/kanban_list_escalations', {}, devTokenRaw)
    expect(res.status).toBe(403)
  })
})

describe('requisição que um site de terceiros poderia ter disparado', () => {
  /** Um POST cru, sem os headers que o helper sempre põe. */
  function rawPost(headers: Record<string, string>): Promise<Response> {
    return fetch(`http://127.0.0.1:${port}/mcp/tool/kanban_create_card`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pmTokenRaw}`, ...headers },
      body: JSON.stringify({ title: 'CSRF', type: 'task', sprint_id: sprintId, ...TOKEN }),
    })
  }

  it('sem content-type json retorna 415 — é o POST simples que dispensa preflight', async () => {
    const res = await rawPost({ 'content-type': 'text/plain;charset=UTF-8' })
    expect(res.status).toBe(415)
    expect(((await res.json()) as Record<string, unknown>)['error']).toBe('unsupported_media_type')
  })

  it('sem content-type nenhum retorna 415', async () => {
    const res = await rawPost({})
    expect(res.status).toBe(415)
  })

  it('Sec-Fetch-Site cross-site retorna 403 mesmo com token válido', async () => {
    const res = await rawPost({
      'content-type': 'application/json',
      'sec-fetch-site': 'cross-site',
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as Record<string, unknown>)['reason']).toBe('cross_site')
  })

  it('Origin de outro host retorna 403', async () => {
    const res = await rawPost({
      'content-type': 'application/json',
      origin: 'https://evil.example',
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as Record<string, unknown>)['reason']).toBe('cross_origin')
  })

  it('same-origin do próprio SPA passa', async () => {
    const res = await rawPost({
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      origin: `http://127.0.0.1:${port}`,
    })
    expect(res.status).toBe(200)
  })

  it('cliente não-navegador passa: curl e agentes não mandam Sec-Fetch-Site', async () => {
    const res = await rawPost({ 'content-type': 'application/json' })
    expect(res.status).toBe(200)
  })

  it('a recusa vem antes da autenticação — token inválido não muda o veredito', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp/tool/kanban_create_card`, {
      method: 'POST',
      headers: { authorization: 'Bearer lixo', 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: '{}',
    })
    expect(res.status).toBe(403)
  })
})

describe('unknown tool', () => {
  it('POST to a non-existent tool returns 501', async () => {
    const res = await httpPost(port, '/mcp/tool/kanban_nonexistent', {}, pmTokenRaw)
    expect(res.status).toBe(501)
    expect((res.body as Record<string, unknown>)['error']).toBe('not_implemented')
  })
})

describe('manager token', () => {
  it('manager can create cards in any project', async () => {
    const mgrIssued = await createManagerToken(paths, 'human:integtest')
    const res = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'Manager Card', type: 'task', sprint_id: sprintId, project: 'test-project', ...TOKEN },
      mgrIssued.raw,
    )
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>)['title']).toBe('Manager Card')
  })
})

describe('GET /flow', () => {
  it('devolve a forma esperada das métricas de fluxo', async () => {
    const res = await httpGet(port, '/flow')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, any>
    for (const k of ['cycle_time_hours', 'decision_latency_hours']) {
      expect(body[k]).toMatchObject({
        count: expect.any(Number),
        p50: expect.any(Number),
        p90: expect.any(Number),
        max: expect.any(Number),
      })
    }
    expect(body['rework']).toMatchObject({ forward: expect.any(Number), backward: expect.any(Number) })
    expect(Array.isArray(body['by_week'])).toBe(true)
    expect(body['audit_truncated']).toBe(false)
  })

  it('aceita o mesmo recorte de datas do /metrics', async () => {
    const res = await httpGet(port, '/flow?from_date=2026-01-01&to_date=2026-12-31')
    expect(res.status).toBe(200)
  })

  it('400 com data malformada', async () => {
    expect((await httpGet(port, '/flow?from_date=01-01-2026')).status).toBe(400)
    expect((await httpGet(port, '/flow?to_date=2026-99-99')).status).toBe(400)
  })
})

describe('GET /digest', () => {
  it('sem week_start, devolve a semana corrente com todas as seções', async () => {
    const res = await httpGet(port, '/digest')
    expect(res.status).toBe(200)
    const body = res.body as Record<string, unknown>
    // Segunda-feira e domingo, seis dias depois.
    expect(body['week_start']).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(new Date(`${body['week_start'] as string}T00:00:00Z`).getUTCDay()).toBe(1)
    expect(new Date(`${body['week_end'] as string}T00:00:00Z`).getUTCDay()).toBe(0)
    for (const key of [
      'sprints_closed',
      'cards_done',
      'goals_done',
      'goals_upcoming',
      'stalled_reviews',
    ]) {
      expect(Array.isArray(body[key])).toBe(true)
    }
    expect(body['activity']).toHaveProperty('summary')
    expect(body['hours_estimate_available']).toBe(true)
  })

  it('normaliza qualquer dia da semana para a segunda', async () => {
    const res = await httpGet(port, '/digest?week_start=2026-07-09')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ week_start: '2026-07-06', week_end: '2026-07-12' })
  })

  it('semana passada não finge estimativa de horas', async () => {
    const res = await httpGet(port, '/digest?week_start=2026-07-06')
    expect((res.body as Record<string, unknown>)['hours_estimate_available']).toBe(false)
  })

  it('400 com week_start malformado ou tz_offset fora da faixa', async () => {
    expect((await httpGet(port, '/digest?week_start=09-07-2026')).status).toBe(400)
    expect((await httpGet(port, '/digest?week_start=2026-13-45')).status).toBe(400)
    expect((await httpGet(port, '/digest?tz_offset=9999')).status).toBe(400)
  })
})

describe('GET /workflow/log', () => {
  it('serve o log do disco com leitura incremental', async () => {
    const res = await httpGet(port, '/workflow/log?sprint_id=wf1')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sprint_id: 'wf1', run: null, data: 'linha um\nlinha dois\n' })

    const size = (res.body as { size: number }).size
    const tail = await httpGet(port, `/workflow/log?sprint_id=wf1&offset=${size}`)
    expect(tail.status).toBe(200)
    expect((tail.body as { data: string }).data).toBe('')
  })

  it('400 sem sprint_id ou com offset inválido', async () => {
    expect((await httpGet(port, '/workflow/log')).status).toBe(400)
    expect((await httpGet(port, '/workflow/log?sprint_id=wf1&offset=-1')).status).toBe(400)
  })

  it('404 para sprint sem execução nem log', async () => {
    expect((await httpGet(port, '/workflow/log?sprint_id=nunca-rodou')).status).toBe(404)
  })
})

describe('GET /workflow/agents', () => {
  it('retorna fase idle e cards vazios quando não há execução em memória', async () => {
    const res = await httpGet(port, '/workflow/agents?sprint_id=wf1')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ sprint_id: 'wf1', run: null, phase: 'idle', in_progress_cards: [] })
  })

  it('400 sem sprint_id', async () => {
    expect((await httpGet(port, '/workflow/agents')).status).toBe(400)
  })

  it('sempre carrega o campo jobs — [] quando nada roda', async () => {
    const res = await httpGet(port, '/workflow/agents?sprint_id=wf1')
    expect(res.status).toBe(200)
    expect((res.body as Record<string, unknown>)['jobs']).toEqual([])
  })

  it('lista só os jobs running da sprint pedida', async () => {
    const created = await httpPost(
      port,
      '/mcp/tool/kanban_create_card',
      { title: 'Job HTTP Card', type: 'task', sprint_id: sprintId, ...TOKEN },
      pmTokenRaw,
    )
    const cardId = (created.body as Record<string, unknown>)['id'] as string
    await jobManager.start({
      jobId: 'job-httptest',
      cardId,
      sprintId,
      project: 'test-project',
      command: 'sleep 5',
      cwd: paths.vault,
      claimedBy: 'agent:dev',
    })

    const mine = await httpGet(port, `/workflow/agents?sprint_id=${sprintId}`)
    const jobs = (mine.body as Record<string, unknown>)['jobs'] as Array<Record<string, unknown>>
    expect(jobs.map((j) => j['job_id'])).toEqual(['job-httptest'])
    expect(typeof jobs[0]!['stalled']).toBe('boolean')

    const other = await httpGet(port, '/workflow/agents?sprint_id=wf1')
    expect((other.body as Record<string, unknown>)['jobs']).toEqual([])

    await jobManager.stop('job-httptest', 'human:test')
    // Espera o finalize terminar (hand-back gravado) antes do teste acabar —
    // sem isso, o afterAll global (dispose + cleanupVault) pode correr
    // enquanto o write do log/card do finalize ainda está em voo.
    await vi.waitFor(async () => {
      const status = await jobManager.status('job-httptest')
      expect(status?.status).toBe('stopped')
    })
  })
})

describe('GET /vault/kad', () => {
  it('lista os arquivos .md de kad/, ordenados pelos ids canônicos primeiro', async () => {
    const kadDir = path.join(paths.kanbanData, 'test-project', 'kad')
    await fs.mkdir(kadDir, { recursive: true })
    await fs.writeFile(path.join(kadDir, 'roadmap.md'), '# Roadmap\n', 'utf8')
    await fs.writeFile(path.join(kadDir, 'vision.md'), '# Visão\n', 'utf8')
    await fs.writeFile(path.join(kadDir, 'extra-doc.md'), '# Extra\n', 'utf8')

    const res = await httpGet(port, '/vault/kad?project=test-project')
    expect(res.status).toBe(200)
    const body = res.body as { project: string; files: Array<{ id: string; label: string }> }
    expect(body.project).toBe('test-project')
    // vision (id canônico, rank menor) antes de roadmap (rank maior), e o
    // desconhecido 'extra-doc' por último, em ordem alfabética.
    expect(body.files.map((f) => f.id)).toEqual(['vision', 'roadmap', 'extra-doc'])
    expect(body.files.find((f) => f.id === 'vision')?.label).toBe('Visão')
    expect(body.files.find((f) => f.id === 'extra-doc')?.label).toBe('extra-doc')
  })

  it('projeto sem kad/ retorna lista vazia, não erro', async () => {
    const res = await httpGet(port, '/vault/kad?project=projeto-sem-planejamento')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ project: 'projeto-sem-planejamento', files: [] })
  })

  it('400 sem project', async () => {
    expect((await httpGet(port, '/vault/kad')).status).toBe(400)
  })
})

describe('GET /vault/kad/doc', () => {
  it('lê o conteúdo de um doc existente', async () => {
    const kadDir = path.join(paths.kanbanData, 'test-project', 'kad')
    await fs.mkdir(kadDir, { recursive: true })
    await fs.writeFile(path.join(kadDir, 'prd.md'), '# PRD\n\nConteúdo.\n', 'utf8')

    const res = await httpGet(port, '/vault/kad/doc?project=test-project&doc=prd')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ project: 'test-project', doc: 'prd', content: '# PRD\n\nConteúdo.\n' })
  })

  it('404 para doc inexistente', async () => {
    const res = await httpGet(port, '/vault/kad/doc?project=test-project&doc=nao-existe')
    expect(res.status).toBe(404)
  })

  it('404 (não 500) para doc com tentativa de path traversal', async () => {
    const traversal = await httpGet(
      port,
      `/vault/kad/doc?project=test-project&doc=${encodeURIComponent('../_meta')}`,
    )
    expect(traversal.status).toBe(404)

    const slash = await httpGet(
      port,
      `/vault/kad/doc?project=test-project&doc=${encodeURIComponent('sub/doc')}`,
    )
    expect(slash.status).toBe(404)
  })

  it('400 sem project ou sem doc', async () => {
    expect((await httpGet(port, '/vault/kad/doc?project=test-project')).status).toBe(400)
    expect((await httpGet(port, '/vault/kad/doc?doc=prd')).status).toBe(400)
  })
})

describe('GET /vault/repo-docs', () => {
  it('lista .md de docs/ dentro do target_repo, recursivamente', async () => {
    const targetRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-repo-docs-'))
    const docsDir = path.join(targetRepo, 'docs')
    await fs.mkdir(path.join(docsDir, 'kad'), { recursive: true })
    await fs.writeFile(path.join(docsDir, 'kad', 'vision.md'), '# Visão\n', 'utf8')
    await fs.writeFile(path.join(docsDir, 'readme.md'), '# Readme\n', 'utf8')

    const meta = await loadProjectMeta(paths, 'test-project')
    await saveProjectMeta(paths, 'test-project', { ...meta, target_repo: targetRepo })

    const res = await httpGet(port, '/vault/repo-docs?project=test-project')
    expect(res.status).toBe(200)
    const body = res.body as { project: string; files: Array<{ id: string }> }
    expect(body.project).toBe('test-project')
    expect(body.files.map((f) => f.id).sort()).toEqual(['kad/vision', 'readme'])

    await fs.rm(targetRepo, { recursive: true, force: true })
    await saveProjectMeta(paths, 'test-project', meta)
  })

  it('projeto sem target_repo (ou sem docs/) retorna lista vazia, não erro', async () => {
    const res = await httpGet(port, '/vault/repo-docs?project=projeto-sem-planejamento')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ project: 'projeto-sem-planejamento', files: [] })
  })

  it('400 sem project', async () => {
    expect((await httpGet(port, '/vault/repo-docs')).status).toBe(400)
  })
})

describe('GET /vault/repo-docs/doc', () => {
  it('lê um doc em subpasta, e rejeita traversal', async () => {
    const targetRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-repo-docs-'))
    const docsDir = path.join(targetRepo, 'docs')
    await fs.mkdir(path.join(docsDir, 'kad'), { recursive: true })
    await fs.writeFile(path.join(docsDir, 'kad', 'vision.md'), '# Visão\n\nConteúdo.\n', 'utf8')

    const meta = await loadProjectMeta(paths, 'test-project')
    await saveProjectMeta(paths, 'test-project', { ...meta, target_repo: targetRepo })

    const ok = await httpGet(port, '/vault/repo-docs/doc?project=test-project&doc=kad/vision')
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({
      project: 'test-project',
      doc: 'kad/vision',
      content: '# Visão\n\nConteúdo.\n',
    })

    const traversal = await httpGet(
      port,
      `/vault/repo-docs/doc?project=test-project&doc=${encodeURIComponent('../../etc/passwd')}`,
    )
    expect(traversal.status).toBe(404)

    await fs.rm(targetRepo, { recursive: true, force: true })
    await saveProjectMeta(paths, 'test-project', meta)
  })

  it('404 sem target_repo configurado', async () => {
    const res = await httpGet(port, '/vault/repo-docs/doc?project=projeto-sem-planejamento&doc=readme')
    expect(res.status).toBe(404)
  })

  it('400 sem project ou sem doc', async () => {
    expect((await httpGet(port, '/vault/repo-docs/doc?project=test-project')).status).toBe(400)
    expect((await httpGet(port, '/vault/repo-docs/doc?doc=readme')).status).toBe(400)
  })
})

// Regressão: HttpServer.stop() usava server.close() puro, que no Node só
// resolve quando TODA conexão aberta termina sozinha — e um stream SSE
// (/events) fica aberto indefinidamente por design. Em produção isso travou
// o shutdown até o SIGKILL, pulando o jobs.dispose() do drenamento gracioso.
// Instância própria (isolada do server principal do arquivo) para não
// interferir com os outros describes.
describe('HttpServer.stop() com uma conexão SSE aberta', () => {
  it('resolve mesmo com um cliente /events conectado, sem esperar o stream fechar sozinho', async () => {
    const shutdownPaths = await createTempVault()
    const db = createTestDb()
    const repo = createTestRepo(db)
    const idempotency = new IdempotencyStore(shutdownPaths.idempotencyStore)
    await idempotency.load()
    const validator = new TokenValidator(shutdownPaths)
    const sse = new SSEEventBus()
    const metrics = new MetricsService(db)
    const activity = new ActivityService(db, shutdownPaths, new GitActivityService())
    const mcpStub = { handleRequest: vi.fn().mockResolvedValue(undefined) } as unknown as McpHttpManager
    const state = { startedAt: Date.now(), vaultPath: shutdownPaths.vault, reconciling: false, db }

    const shutdownServer = new HttpServer({
      port: 0,
      host: '127.0.0.1',
      state,
      validator,
      idempotency,
      sse,
      metrics,
      activity,
      digest: new DigestService(
        shutdownPaths,
        repo,
        metrics,
        activity,
        new SupervisionService(shutdownPaths, repo),
      ),
      flow: new FlowService(shutdownPaths, metrics),
      mcp: mcpStub,
    })
    await shutdownServer.start()
    const shutdownPort = shutdownServer.getPort()!

    // Abre uma conexão SSE de verdade e a mantém aberta — nunca chamamos
    // res.destroy()/abort() no cliente, o ponto é o servidor derrubá-la.
    const opened = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${shutdownPort}/events`, resolve)
      req.on('error', reject)
    })
    expect(opened.statusCode).toBe(200)
    expect(sse.size()).toBe(1)

    const t0 = Date.now()
    await shutdownServer.stop()
    const elapsedMs = Date.now() - t0

    // Bem abaixo do timeout de segurança (HTTP_SHUTDOWN_TIMEOUT_MS) — a
    // conexão foi ativamente encerrada, não esperada.
    expect(elapsedMs).toBeLessThan(HTTP_SHUTDOWN_TIMEOUT_MS)

    await cleanupVault(shutdownPaths)
  })
})
