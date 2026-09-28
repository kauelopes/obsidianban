import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ModuleHttpError, type ModuleContext, type ServerModule } from '@obsidiankan/module-sdk'
import type { SSEEvent } from '@obsidiankan/types'
import type { Paths } from '../../src/config.js'
import { HttpServer } from '../../src/server/http.js'
import { TokenValidator } from '../../src/auth/validator.js'
import { IdempotencyStore } from '../../src/server/idempotency.js'
import { SSEEventBus } from '../../src/server/sse.js'
import { ModuleHost } from '../../src/modules/host.js'
import { ModuleSettingsStore } from '../../src/modules/settings-store.js'
import { StubLlmProvider } from '../../src/llm/stub.js'
import { createAgentToken, createManagerToken } from '../../src/auth/tokens.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import { createTestDb } from '../helpers/db.js'
import { httpGet, httpPost } from '../helpers/http.js'

let paths: Paths
let server: HttpServer
let port: number
let managerRaw: string
let pmRaw: string
let devRaw: string
let host: ModuleHost
let settingsFile: string
let captured: ModuleContext | null = null
const emitted: SSEEvent[] = []

const echoModule: ServerModule = {
  id: 'echo',
  name: 'Echo',
  version: '1.0.0',
  description: 'módulo de teste',
  register(ctx) {
    captured = ctx
    ctx.routes.register('GET', '/', 'bearer', async (req) => ({
      json: { actor: req.claims?.actor, q: req.query.get('q') },
    }))
    ctx.routes.register('GET', '/items/:id', 'lan', async (req) => ({ json: { id: req.params['id'], claims: req.claims } }))
    ctx.routes.register('POST', '/items', 'pm', async (req) => {
      ctx.events.emit('item_created', req.body)
      return { status: 201, json: { created: req.body } }
    })
    ctx.routes.register('GET', '/file', 'bearer', async () => ({
      file: { data: new TextEncoder().encode('%PDF-fake'), contentType: 'application/pdf', filename: 'relatório.pdf' },
    }))
    ctx.routes.register('GET', '/conflict', 'bearer', async () => {
      throw new ModuleHttpError(409, { error: 'busy' })
    })
    ctx.routes.register('GET', '/crash', 'bearer', async () => {
      throw new Error('bug no módulo')
    })
    ctx.routes.register('DELETE', '/items/:id', 'manager', async (req) => ({ json: { deleted: req.params['id'] } }))
  },
}

const brokenModule: ServerModule = {
  id: 'broken',
  name: 'Broken',
  version: '0.0.1',
  description: 'register lança',
  register() {
    throw new Error('dependência ausente')
  },
}

async function put(urlPath: string, body: unknown, token?: string) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

beforeAll(async () => {
  paths = await createTempVault()
  await setupTestProject(paths, 'test-project')
  managerRaw = (await createManagerToken(paths, 'human:owner')).raw
  pmRaw = (await createAgentToken(paths, 'test-project', 'agent:pm', 'pm')).raw
  devRaw = (await createAgentToken(paths, 'test-project', 'agent:dev', 'dev')).raw

  const sse = new SSEEventBus()
  const origEmit = sse.emit.bind(sse)
  sse.emit = (e: SSEEvent) => {
    emitted.push(e)
    origEmit(e)
  }
  settingsFile = path.join(paths.kanbanInternal, 'modules.json')
  const settings = new ModuleSettingsStore(settingsFile)
  await settings.load()
  host = new ModuleHost({
    paths,
    settings,
    sse,
    data: {} as never,
    llmFor: () => new StubLlmProvider(),
    env: {},
  })
  await host.load([echoModule, brokenModule, { ...echoModule, name: 'Echo duplicado' }])

  const idempotency = new IdempotencyStore(paths.idempotencyStore)
  await idempotency.load()
  server = new HttpServer({
    port: 0,
    host: '127.0.0.1',
    state: { startedAt: Date.now(), vaultPath: paths.vault, reconciling: false, db: createTestDb() },
    validator: new TokenValidator(paths),
    idempotency,
    sse,
    metrics: {} as never,
    activity: {} as never,
    digest: {} as never,
    flow: {} as never,
    mcp: {} as never,
    modules: host,
  })
  await server.start()
  port = server.getPort()!
})

afterAll(async () => {
  await server.stop()
  await cleanupVault(paths)
})

describe('módulos — carga e listagem', () => {
  it('register recebe contexto com dataDir criado e settings desativadas', async () => {
    expect(captured).not.toBeNull()
    expect(captured!.dataDir).toBe(path.join(paths.kanbanInternal, 'modules', 'echo'))
    await expect(fs.stat(captured!.dataDir)).resolves.toBeTruthy()
    expect(captured!.settings()).toEqual({ enabled: false, config: {} })
  })

  it('GET /modules exige token e lista instalados; register que lança vira load_error', async () => {
    expect((await httpGet(port, '/modules')).status).toBe(401)
    const res = await httpGet(port, '/modules', devRaw)
    expect(res.status).toBe(200)
    const mods = (res.body as { modules: Array<{ id: string; enabled: boolean; load_error: string | null }> }).modules
    // id duplicado no registry: só a primeira cópia entra.
    expect(mods.map((m) => m.id)).toEqual(['echo', 'broken'])
    expect(mods[0]).toMatchObject({ enabled: false, load_error: null })
    expect(mods[1]!.load_error).toBe('dependência ausente')
  })

  it('módulo desativado responde 404 em qualquer rota — igual a inexistente', async () => {
    expect((await httpGet(port, '/modules/echo/', managerRaw)).status).toBe(404)
    expect((await httpGet(port, '/modules/nada/', managerRaw)).status).toBe(404)
  })
})

describe('módulos — ativação', () => {
  it('só manager ativa; mudança persiste em modules.json e emite MODULE_EVENT core', async () => {
    expect((await put('/modules/echo', { enabled: true }, pmRaw)).status).toBe(403)
    expect((await put('/modules/echo', { enabled: 'sim' }, managerRaw)).status).toBe(400)

    const res = await put('/modules/echo', { enabled: true, config: { tema: 'x' } }, managerRaw)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ id: 'echo', enabled: true, config: { tema: 'x' } })
    expect(captured!.settings()).toEqual({ enabled: true, config: { tema: 'x' } })

    const onDisk = JSON.parse(await fs.readFile(settingsFile, 'utf8'))
    expect(onDisk.echo).toEqual({ enabled: true, config: { tema: 'x' } })

    const reloaded = new ModuleSettingsStore(settingsFile)
    await reloaded.load()
    expect(reloaded.get('echo').enabled).toBe(true)

    expect(emitted.at(-1)).toEqual({
      type: 'MODULE_EVENT',
      payload: { module: 'core', event: 'modules_changed', payload: { id: 'echo', enabled: true } },
    })
  })

  it('ativar módulo com load_error não o coloca no ar', async () => {
    await put('/modules/broken', { enabled: true }, managerRaw)
    expect(host.isActive('broken')).toBe(false)
  })

  it('PUT em módulo não instalado é 404', async () => {
    expect((await put('/modules/nada', { enabled: true }, managerRaw)).status).toBe(404)
  })
})

describe('módulos — rotas ativas', () => {
  it('bearer: claims e query chegam ao handler', async () => {
    const res = await httpGet(port, '/modules/echo/?q=abc', devRaw)
    expect(res).toEqual({ status: 200, body: { actor: 'agent:dev', q: 'abc' } })
    expect((await httpGet(port, '/modules/echo/')).status).toBe(401)
  })

  it('lan: sem token no loopback, com parâmetro de caminho decodificado', async () => {
    const res = await httpGet(port, '/modules/echo/items/a%20b')
    expect(res).toEqual({ status: 200, body: { id: 'a b', claims: null } })
  })

  it('pm: dev é recusado; pm cria e o módulo emite evento no envelope', async () => {
    expect((await httpPost(port, '/modules/echo/items', { n: 1 }, devRaw)).status).toBe(403)
    const res = await httpPost(port, '/modules/echo/items', { n: 1 }, pmRaw)
    expect(res).toEqual({ status: 201, body: { created: { n: 1 } } })
    expect(emitted.at(-1)).toEqual({
      type: 'MODULE_EVENT',
      payload: { module: 'echo', event: 'item_created', payload: { n: 1 } },
    })
  })

  it('mutação sem content-type JSON é recusada antes do handler', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/modules/echo/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${pmRaw}`, 'content-type': 'text/plain' },
      body: '{}',
    })
    expect(res.status).toBe(415)
  })

  it('manager: DELETE com token de manager', async () => {
    const del = (token: string) =>
      fetch(`http://127.0.0.1:${port}/modules/echo/items/x`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      })
    expect((await del(pmRaw)).status).toBe(403)
    const res = await del(managerRaw)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ deleted: 'x' })
  })

  it('resposta binária sai com content-type e nome de arquivo', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/modules/echo/file`, {
      headers: { authorization: `Bearer ${devRaw}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''relat%C3%B3rio.pdf")
    expect(await res.text()).toBe('%PDF-fake')
  })

  it('ModuleHttpError vira status + corpo; erro qualquer vira 500 sem vazar a mensagem', async () => {
    expect(await httpGet(port, '/modules/echo/conflict', devRaw)).toEqual({ status: 409, body: { error: 'busy' } })
    expect(await httpGet(port, '/modules/echo/crash', devRaw)).toEqual({
      status: 500,
      body: { error: 'internal_error', module: 'echo' },
    })
  })

  it('método errado em rota existente é 405 com Allow; caminho inexistente é 404', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/modules/echo/file`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${managerRaw}`, 'content-type': 'application/json' },
      body: '{}',
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('GET')
    expect((await httpGet(port, '/modules/echo/nao/existe', devRaw)).status).toBe(404)
  })

  it('desativar tira o módulo do ar de novo, sem restart', async () => {
    await put('/modules/echo', { enabled: false }, managerRaw)
    expect((await httpGet(port, '/modules/echo/', devRaw)).status).toBe(404)
    // config sobrevive ao toggle
    expect(captured!.settings()).toEqual({ enabled: false, config: { tema: 'x' } })
  })
})
