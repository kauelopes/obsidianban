import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { HttpServer } from '../../src/server/http.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { IdempotencyStore } from '../../src/server/idempotency.js'
import { TokenValidator } from '../../src/auth/validator.js'
import { MetricsService } from '../../src/services/metrics.js'
import { CardService } from '../../src/services/card.js'
import { SprintService } from '../../src/services/sprint.js'
import { AtomicWriter } from '../../src/writer/atomic.js'
import { AuditLogger } from '../../src/audit/logger.js'
import { createAgentToken, createManagerToken, revokeAgentToken } from '../../src/auth/tokens.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb, createTestRepo } from '../helpers/db.js'
import { makeManagerClaims } from '../helpers/factories.js'
import { httpPost, httpGet } from '../helpers/http.js'
import type { McpHttpManager } from '../../src/server/mcp-http.js'

let paths: Paths
let server: HttpServer
let port: number
let pmTokenRaw: string
let devTokenRaw: string
let sprintId: string

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

  server = new HttpServer({ port: 0, state, validator, idempotency, sse, metrics, mcp: mcpStub })

  server.registerTool('kanban_create_card', (p, c) =>
    cardService.create(p as Record<string, unknown>, c),
  )
  server.registerTool('kanban_get_card', (p, c) =>
    cardService.get(p as Record<string, unknown>, c),
  )
  server.registerTool('kanban_create_sprint', (p, c) =>
    sprintService.createSprint(p as Record<string, unknown>, c),
  )

  await server.start()
  port = server.getPort()!
})

afterAll(async () => {
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
