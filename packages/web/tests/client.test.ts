import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { KanbanClient } from '../src/api/client.js'

interface Call {
  url: string
  body: Record<string, unknown>
  auth: string | undefined
}

let calls: Call[]
let respond: (url: string) => { status: number; body: unknown }

beforeEach(() => {
  calls = []
  respond = () => ({ status: 200, body: {} })
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    calls.push({
      url,
      body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {},
      auth: headers['Authorization'],
    })
    const r = respond(url)
    return {
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response
  })
})

afterEach(() => vi.unstubAllGlobals())

const client = () => new KanbanClient({ token: 'tok-123' })

describe('KanbanClient — transport', () => {
  it('posts to /mcp/tool/<name> with a bearer token', async () => {
    await client().getCard('card-1')
    expect(calls[0]!.url).toBe('/mcp/tool/kanban_get_card')
    expect(calls[0]!.auth).toBe('Bearer tok-123')
    expect(calls[0]!.body).toEqual({ id: 'card-1' })
  })

  it('hits GET /health without a tool call', async () => {
    respond = () => ({ status: 200, body: { status: 'ok', cards_indexed: 3 } })
    const res = await client().health()
    expect(calls[0]!.url).toBe('/health')
    expect(res.ok).toBe(true)
  })
})

describe('KanbanClient — sprints come from their own tool', () => {
  /**
   * Regression: the board's sprint filter was always empty because the code
   * read `sprints` off the kanban_list_projects response. That tool returns
   * only project shape (columns, archived, target_repo) — sprints live in
   * _meta.json and are served by kanban_list_sprints, one call per project.
   */
  it('listProjects does not carry sprints', async () => {
    respond = () => ({
      status: 200,
      body: { projects: [{ project: 'p1', columns: ['todo'], archived: false }] },
    })
    const res = await client().listProjects()
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.data.projects[0]).not.toHaveProperty('sprints')
  })

  it('listSprints asks for a project explicitly', async () => {
    respond = () => ({ status: 200, body: { sprints: [] } })
    await client().listSprints({ project: 'p1', status: 'all' })
    expect(calls[0]!.url).toBe('/mcp/tool/kanban_list_sprints')
    expect(calls[0]!.body).toEqual({ project: 'p1', status: 'all' })
  })
})

describe('KanbanClient — archived cards', () => {
  /**
   * Regression: the board asked for cards without include_archived, and
   * kanban_list_cards hides archived by default. Closing a sprint auto-archives
   * everything in 'done', so a project whose sprints are all closed rendered as
   * a completely empty board with no way to see anything.
   */
  it('passes include_archived through to the server', async () => {
    respond = () => ({ status: 200, body: { cards: [] } })
    await client().listCards({ limit: 200, include_archived: true })
    expect(calls[0]!.body).toEqual({ limit: 200, include_archived: true })
  })

  it('sends include_archived:false explicitly rather than omitting it', async () => {
    respond = () => ({ status: 200, body: { cards: [] } })
    await client().listCards({ limit: 200, include_archived: false })
    expect(calls[0]!.body).toHaveProperty('include_archived', false)
  })
})

describe('KanbanClient — human attribution', () => {
  it('stamps writes as model:human with zero token cost', async () => {
    respond = () => ({ status: 200, body: {} })
    await client().updateSpec({ id: 'card-1', version: 2, spec: 'x' })
    expect(calls[0]!.body).toMatchObject({
      id: 'card-1',
      version: 2,
      spec: 'x',
      input_tokens: 0,
      output_tokens: 0,
      model: 'human',
    })
  })

  it('does not stamp read-only calls', async () => {
    await client().listCards({ limit: 200 })
    expect(calls[0]!.body).toEqual({ limit: 200 })
  })
})

describe('KanbanClient — failures never throw', () => {
  it('turns a network failure into an offline result', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED')
    })
    const res = await client().getCard('card-1')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('offline')
  })

  it('turns a non-JSON body into a server error rather than crashing', async () => {
    vi.stubGlobal('fetch', async () => ({
      status: 502,
      json: async () => JSON.parse('<'),
      text: async () => '<html>bad gateway</html>',
    }) as unknown as Response)
    const res = await client().getCard('card-1')
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('server')
    expect(res.error.status).toBe(502)
  })

  it('surfaces a 409 as a conflict', async () => {
    respond = () => ({
      status: 409,
      body: { current_version: 5, your_version: 4, conflicting_fields: ['body'], current_card: {} },
    })
    const res = await client().updateSpec({ id: 'c', version: 4, spec: 'x' })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.error.kind).toBe('conflict')
  })
})
