// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ModuleHost } from '@obsidiankan/module-sdk/web'
import type { ReportMeta, ReportOptions } from '../../server/api-types.js'
import { ReportsView } from '../../web/ReportsView.js'
import { periodPresets } from '../../web/periods.js'

afterEach(cleanup)

function meta(over: Partial<ReportMeta> = {}): ReportMeta {
  return {
    id: 'rep-20260720-aaaaaa',
    type: 'sprint',
    title: 'Sprint S1 · alfa',
    params: { type: 'sprint', project: 'alfa', sprint_id: 'sprint-1', from: '2026-07-06', to: '2026-07-10', include_analysis: false },
    status: 'done',
    period: { from: '2026-07-06', to: '2026-07-10' },
    created_at: '2026-07-20T12:00:00.000Z',
    created_by: 'human:x',
    finished_at: '2026-07-20T12:00:05.000Z',
    error: null,
    pdf: { status: 'ready', error: null, bytes: 1000 },
    analysis: { status: 'skipped', provider: null, model: null, error: null, usage: null },
    warnings: [],
    ...over,
  }
}

const OPTIONS: ReportOptions = {
  types: [
    { id: 'sprint', label: 'Relatório de sprint', description: 'd', needs: ['project', 'sprint'] },
    { id: 'project', label: 'Relatório de projeto', description: 'd', needs: ['project', 'period'] },
    { id: 'board', label: 'Relatório do board', description: 'd', needs: ['period'] },
  ],
  projects: [{ name: 'alfa', sprints: [{ id: 'sprint-1', name: 'S1', status: 'active', started_at: '2026-07-06T00:00:00Z', ended_at: null }] }],
  renderer: { available: false, python: 'python3', reason: 'python indisponível' },
  llm: { provider: 'claude-cli', model: null },
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeHost(routes: (path: string, init?: RequestInit) => Response) {
  let listener: ((event: string, payload: unknown) => void) | null = null
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const host: ModuleHost = {
    moduleId: 'reports',
    config: {},
    saveConfig: async () => ({ ok: true }),
    ui: {
      Markdown: ({ children }) => <div data-testid="md">{children}</div>,
      Dialog: ({ title, children, footer }) => (
        <div role="dialog" aria-label={title}>
          {children}
          {footer}
        </div>
      ),
    },
    api: {
      fetch: async (path, init) => {
        calls.push({ path, ...(init ? { init } : {}) })
        return routes(path, init)
      },
      onEvent: (h) => {
        listener = h
        return () => {
          listener = null
        }
      },
    },
  }
  return { host, calls, emit: (event: string, payload: unknown) => listener?.(event, payload) }
}

describe('ReportsView', () => {
  it('lista, abre um relatório pronto e mostra o Markdown', async () => {
    const { host } = makeHost((path) => {
      if (path === '/?project=alfa') return json(200, { reports: [meta()] })
      if (path.endsWith('/markdown')) return json(200, { id: 'x', markdown: '# Sprint S1' })
      return json(404, null)
    })
    render(<ReportsView host={host} project="alfa" />)
    fireEvent.click(await screen.findByText('Sprint S1 · alfa'))
    expect((await screen.findByTestId('md')).textContent).toBe('# Sprint S1')
    expect(screen.getByRole('button', { name: 'baixar PDF' })).toBeTruthy()
  })

  it('evento de progresso recarrega a lista e o relatório vira pronto sem reload', async () => {
    let status: ReportMeta['status'] = 'collecting'
    const { host, emit } = makeHost((path) => {
      if (path.startsWith('/?')) return json(200, { reports: [meta({ status })] })
      if (path.endsWith('/markdown')) return json(200, { id: 'x', markdown: 'pronto!' })
      return json(404, null)
    })
    render(<ReportsView host={host} project="alfa" />)
    fireEvent.click(await screen.findByText('Sprint S1 · alfa'))
    expect(await screen.findByLabelText('Progresso da geração')).toBeTruthy()

    status = 'done'
    emit('progress', { id: 'rep-20260720-aaaaaa', status: 'done', project: 'alfa' })
    expect((await screen.findByTestId('md')).textContent).toBe('pronto!')
  })

  it('PDF indisponível mostra o motivo e oferece tentar de novo', async () => {
    const { host, calls } = makeHost((path, init) => {
      if (path.startsWith('/?')) return json(200, { reports: [meta({ pdf: { status: 'unavailable', error: 'rode make reports-setup', bytes: null } })] })
      if (path.endsWith('/markdown')) return json(200, { id: 'x', markdown: 'ok' })
      if (path.endsWith('/pdf') && init?.method === 'POST') return json(200, meta())
      return json(404, null)
    })
    render(<ReportsView host={host} project="alfa" />)
    fireEvent.click(await screen.findByText('Sprint S1 · alfa'))
    expect(await screen.findByText(/PDF indisponível: rode make reports-setup/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'tentar PDF de novo' }))
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/pdf') && c.init?.method === 'POST')).toBe(true))
  })

  it('gera relatório de sprint no projeto: sem tipo board, sprint ativa pré-selecionada', async () => {
    const { host, calls } = makeHost((path, init) => {
      if (path.startsWith('/?')) return json(200, { reports: [] })
      if (path === '/options') return json(200, OPTIONS)
      if (path === '/' && init?.method === 'POST') return json(202, meta({ status: 'queued' }))
      return json(404, null)
    })
    render(<ReportsView host={host} project="alfa" />)
    fireEvent.click(await screen.findByRole('button', { name: 'gerar relatório' }))
    const dialog = await screen.findByRole('dialog', { name: 'Gerar relatório' })
    expect(within(dialog).queryByText('Relatório do board')).toBeNull()
    expect(within(dialog).getByText(/PDF indisponível neste servidor/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('checkbox'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'gerar' }))

    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true))
    const post = calls.find((c) => c.init?.method === 'POST')!
    expect(JSON.parse(String(post.init!.body))).toEqual({ type: 'sprint', include_analysis: true, project: 'alfa', sprint_id: 'sprint-1' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('relatório de projeto manda o período do atalho escolhido', async () => {
    const { host, calls } = makeHost((path, init) => {
      if (path.startsWith('/?')) return json(200, { reports: [] })
      if (path === '/options') return json(200, OPTIONS)
      if (path === '/' && init?.method === 'POST') return json(202, meta({ status: 'queued' }))
      return json(404, null)
    })
    render(<ReportsView host={host} project="alfa" />)
    fireEvent.click(await screen.findByRole('button', { name: 'gerar relatório' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText(/Relatório de projeto/))
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Últimos 7 dias' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'gerar' }))
    await waitFor(() => expect(calls.some((c) => c.init?.method === 'POST')).toBe(true))
    const body = JSON.parse(String(calls.find((c) => c.init?.method === 'POST')!.init!.body))
    const seven = periodPresets().find((p) => p.id === '7d')!
    expect(body).toEqual({ type: 'project', include_analysis: false, project: 'alfa', from: seven.from, to: seven.to })
  })

  it('erro do servidor aparece legível no diálogo', async () => {
    const { host } = makeHost((path, init) => {
      if (path.startsWith('/?')) return json(200, { reports: [] })
      if (path === '/options') return json(200, OPTIONS)
      if (init?.method === 'POST') return json(403, { error: 'forbidden' })
      return json(404, null)
    })
    render(<ReportsView host={host} project="alfa" />)
    fireEvent.click(await screen.findByRole('button', { name: 'gerar relatório' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'gerar' }))
    expect(await screen.findByText(/sem permissão/)).toBeTruthy()
  })
})

describe('periodPresets', () => {
  it('pontas inclusivas e mês anterior certo na virada de ano', () => {
    const p = Object.fromEntries(periodPresets('2026-01-15').map((x) => [x.id, [x.from, x.to]]))
    expect(p['7d']).toEqual(['2026-01-09', '2026-01-15'])
    expect(p['mes']).toEqual(['2026-01-01', '2026-01-15'])
    expect(p['mes-anterior']).toEqual(['2025-12-01', '2025-12-31'])
  })
})
