import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModuleHttpError } from '@obsidiankan/module-sdk'
import { createReportsModule } from '../../server/index.js'
import type { ReportListResponse, ReportMarkdownResponse, ReportMeta, ReportOptions } from '../../server/api-types.js'
import { ReportStore } from '../../server/store.js'
import { FakeLlm, card, fakeContext, fakeData, fakePdf, move } from './fixtures.js'

const NOW = new Date('2026-07-20T12:00:00.000Z')
let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reports-'))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function data() {
  return fakeData({
    cards: [
      card({ id: 'c1', title: 'Login', status: 'done', total_cost_usd: 1 }),
      card({ id: 'c2', title: 'Sessão', status: 'todo' }),
    ],
    moves: [
      move('c1', 'todo', 'in_progress', '2026-07-06T10:00:00.000Z'),
      move('c1', 'in_progress', 'done', '2026-07-07T10:00:00.000Z'),
    ],
  })
}

async function setup(opts: { pdfAvailable?: boolean; llm?: FakeLlm; config?: Record<string, unknown> } = {}) {
  const llm = opts.llm ?? new FakeLlm()
  const pdf = fakePdf(opts.pdfAvailable ?? false)
  const mod = createReportsModule({ pdf, now: () => NOW })
  const f = fakeContext(dir, data(), llm, opts.config)
  await mod.register(f.ctx)
  return { ...f, mod, llm, pdf }
}

async function generate(f: Awaited<ReturnType<typeof setup>>, body: Record<string, unknown>) {
  const res = await f.call('POST', '/', { body })
  expect(res).toMatchObject({ status: 202 })
  const meta = (res as { json: ReportMeta }).json
  await f.mod.runner()!.idle()
  return (await f.call('GET', '/:id', { params: { id: meta.id } }) as { json: ReportMeta }).json
}

describe('módulo reports — rotas e pipeline', () => {
  it('registra as rotas com a postura de auth certa', async () => {
    const f = await setup()
    expect(f.routes.map((r) => `${r.method} ${r.pattern} ${r.auth}`)).toEqual([
      'GET /options bearer',
      'GET / bearer',
      'POST / pm',
      'GET /:id bearer',
      'GET /:id/markdown bearer',
      'GET /:id/pdf bearer',
      'POST /:id/pdf pm',
      'DELETE /:id pm',
    ])
  })

  it('options lista tipos, projetos com sprints, renderer e LLM', async () => {
    const f = await setup()
    const body = ((await f.call('GET', '/options')) as { json: ReportOptions }).json
    expect(body.types.map((t) => t.id)).toContain('sprint')
    expect(body.projects[0]).toMatchObject({ name: 'alfa', sprints: [{ id: 'sprint-aaaa0001', name: 'S1', status: 'closed' }] })
    expect(body.renderer).toMatchObject({ available: false })
    expect(body.llm).toEqual({ provider: 'fake', model: 'fake-1' })
  })

  it('gera relatório de sprint: progresso por eventos, MD salvo, PDF indisponível sem derrubar', async () => {
    const f = await setup()
    const meta = await generate(f, { type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' })

    expect(meta).toMatchObject({
      status: 'done',
      title: 'Sprint S1 · alfa',
      created_by: 'human:tester',
      period: { from: '2026-07-06', to: '2026-07-10' },
      pdf: { status: 'unavailable', error: 'python indisponível (teste)' },
      analysis: { status: 'skipped' },
    })
    expect(f.events.map((e) => (e.payload as { status: string }).status)).toEqual(['queued', 'collecting', 'rendering', 'done'])
    expect(f.events.every((e) => e.event === 'progress')).toBe(true)

    const md = ((await f.call('GET', '/:id/markdown', { params: { id: meta.id } })) as { json: ReportMarkdownResponse }).json
    expect(md.markdown).toContain('# Sprint S1')
    expect(md.markdown).toContain('| **1 de 2** |')

    await expect(f.call('GET', '/:id/pdf', { params: { id: meta.id } })).rejects.toMatchObject({ status: 409 })
  })

  it('com renderer disponível o PDF sai pronto e é servido como arquivo', async () => {
    const f = await setup({ pdfAvailable: true })
    const meta = await generate(f, { type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' })
    expect(meta.pdf).toMatchObject({ status: 'ready', bytes: 13 })
    const res = await f.call('GET', '/:id/pdf', { params: { id: meta.id } })
    expect(res).toMatchObject({ file: { contentType: 'application/pdf', filename: 'relatorio-sprint-s1-alfa-2026-07-20.pdf' } })
  })

  it('análise por IA entra logo após o Resumo, com uso registrado', async () => {
    const f = await setup()
    const meta = await generate(f, { type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001', include_analysis: true })
    expect(meta.analysis).toMatchObject({ status: 'done', provider: 'fake', model: 'fake-1', usage: { usd: 0.01 } })
    expect(f.events.map((e) => (e.payload as { status: string }).status)).toContain('analyzing')
    expect(f.llm.prompts[0]).toContain('"concluidos": 1')

    const doc = await new ReportStore(f.ctx.dataDir).loadDocument(meta.id)
    expect(doc!.sections.map((s) => s.title).slice(0, 2)).toEqual(['Resumo', 'Análise'])
  })

  it('LLM falhando não derruba o relatório: sai sem análise e com nota', async () => {
    const llm = new FakeLlm({ ok: false, text: '', error: 'hit your session limit', rateLimited: true })
    const f = await setup({ llm })
    const meta = await generate(f, { type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001', include_analysis: true })
    expect(meta.status).toBe('done')
    expect(meta.analysis).toMatchObject({ status: 'failed', error: 'limite de uso do LLM atingido: hit your session limit' })
    const md = ((await f.call('GET', '/:id/markdown', { params: { id: meta.id } })) as { json: ReportMarkdownResponse }).json
    expect(md.markdown).toContain('A análise por IA foi pedida mas falhou')
    expect(md.markdown).not.toContain('## Análise')
  })

  it('valida o pedido antes de enfileirar', async () => {
    const f = await setup()
    await expect(f.call('POST', '/', { body: { type: 'nada' } })).rejects.toBeInstanceOf(ModuleHttpError)
    await expect(f.call('POST', '/', { body: { type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001', include_analysis: 'sim' } })).rejects.toMatchObject({ status: 400 })
    expect(((await f.call('GET', '/')) as { json: ReportListResponse }).json.reports).toEqual([])
  })

  it('lista filtra por projeto; delete remove; id inválido é 404', async () => {
    const f = await setup()
    const meta = await generate(f, { type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' })
    const list = async (q: string) => ((await f.call('GET', '/', { query: new URLSearchParams(q) })) as { json: ReportListResponse }).json.reports
    expect((await list('project=alfa')).map((r) => r.id)).toEqual([meta.id])
    expect(await list('project=beta')).toEqual([])

    await f.call('DELETE', '/:id', { params: { id: meta.id } })
    expect(await list('')).toEqual([])
    await expect(f.call('GET', '/:id', { params: { id: '../../etc' } })).rejects.toMatchObject({ status: 404 })
  })

  it('refaz o PDF depois que o renderer fica disponível', async () => {
    const f = await setup()
    const meta = await generate(f, { type: 'sprint', project: 'alfa', sprint_id: 'sprint-aaaa0001' })
    expect(meta.pdf.status).toBe('unavailable')
    // Mesmo diretório de dados, renderer agora disponível (make reports-setup).
    const g = await setup({ pdfAvailable: true })
    const again = ((await g.call('POST', '/:id/pdf', { params: { id: meta.id } })) as { json: ReportMeta }).json
    expect(again.pdf.status).toBe('ready')
  })

  it('relatório interrompido por restart vira failed no próximo boot', async () => {
    const store = new ReportStore(path.join(dir))
    const stuck = {
      id: 'rep-20260720-abcdef',
      status: 'collecting',
      params: { type: 'sprint', project: 'alfa', sprint_id: null, from: null, to: null, include_analysis: false },
      created_at: NOW.toISOString(),
    } as unknown as ReportMeta
    await store.saveMeta(stuck)
    const f = await setup()
    const meta = ((await f.call('GET', '/:id', { params: { id: stuck.id } })) as { json: ReportMeta }).json
    expect(meta.status).toBe('failed')
    expect(meta.error).toMatch(/reiniciou/)
  })
})
