import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { ModulePageProps, WebModule } from '@obsidiankan/module-sdk/web'
import type { ModuleInfo } from '@obsidiankan/types'
import { KanbanClient } from '../src/api/client.js'
import { ModulesProvider } from '../src/modules/ModulesContext.js'
import { ModulePage } from '../src/modules/ModuleRoutes.js'
import { ModulesPanel } from '../src/configs/ModulesPanel.js'
import { Shell } from '../src/ui/Shell.js'

function jsonResponse(status: number, body: unknown) {
  return { status, ok: status < 400, text: async () => JSON.stringify(body), json: async () => body } as Response
}

function info(over: Partial<ModuleInfo> = {}): ModuleInfo {
  return {
    id: 'echo',
    name: 'Echo',
    version: '1.0.0',
    description: 'módulo de teste',
    enabled: true,
    config: { tema: 'x' },
    load_error: null,
    ...over,
  }
}

function EchoPage({ host }: ModulePageProps) {
  return (
    <div>
      <p>página echo · tema {String(host.config['tema'])}</p>
      <button onClick={() => void host.api.fetch('/ping')}>ping</button>
    </div>
  )
}

const ECHO: WebModule = { id: 'echo', page: { navLabel: 'Eco', component: EchoPage } }

function stubFetch(modules: ModuleInfo[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) })
    if (url.endsWith('/modules') && (!init?.method || init.method === 'GET')) return jsonResponse(200, { modules })
    if (/\/modules\/echo$/.test(url) && init?.method === 'PUT') {
      const patch = JSON.parse(String(init.body)) as { enabled: boolean }
      modules = modules.map((m) => (m.id === 'echo' ? { ...m, enabled: patch.enabled } : m))
      return jsonResponse(200, modules[0])
    }
    if (url.includes('kanban_planning_list')) return jsonResponse(200, { sessions: [] })
    return jsonResponse(200, {})
  })
  return calls
}

const client = () => new KanbanClient({ token: 'tok' })

describe('módulos na interface', () => {
  it('módulo ativo com página ganha item no menu, antes de Configs', async () => {
    stubFetch([info()])
    const c = client()
    render(
      <MemoryRouter>
        <ModulesProvider client={c} installed={[ECHO]}>
          <Shell client={c} onLogout={() => {}}>
            <div />
          </Shell>
        </ModulesProvider>
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: 'Eco' })
    expect(link.getAttribute('href')).toBe('/m/echo')
    const labels = screen.getAllByRole('link').map((a) => a.textContent)
    expect(labels.indexOf('Eco')).toBeLessThan(labels.indexOf('Configs'))
  })

  it('módulo desativado (ou com erro de carga) não aparece no menu', async () => {
    const calls = stubFetch([info({ enabled: false })])
    const c = client()
    render(
      <MemoryRouter>
        <ModulesProvider client={c} installed={[ECHO]}>
          <Shell client={c} onLogout={() => {}}>
            <div />
          </Shell>
        </ModulesProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(calls.some((x) => x.url.endsWith('/modules'))).toBe(true))
    expect(screen.queryByRole('link', { name: 'Eco' })).toBeNull()
  })

  it('página do módulo recebe host com config e fetch prefixado e autenticado', async () => {
    const calls = stubFetch([info()])
    const c = client()
    render(
      <MemoryRouter initialEntries={['/m/echo']}>
        <ModulesProvider client={c} installed={[ECHO]}>
          <Routes>
            <Route path="/m/:moduleId/*" element={<ModulePage />} />
          </Routes>
        </ModulesProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText('página echo · tema x')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ping' }))
    await waitFor(() => expect(calls.some((x) => x.url.endsWith('/modules/echo/ping'))).toBe(true))
    const ping = calls.find((x) => x.url.endsWith('/modules/echo/ping'))!
    expect(new Headers(ping.init?.headers).get('Authorization')).toBe('Bearer tok')
  })

  it('rota de módulo inativo explica e aponta para Configs → Módulos', async () => {
    stubFetch([info({ enabled: false })])
    const c = client()
    render(
      <MemoryRouter initialEntries={['/m/echo']}>
        <ModulesProvider client={c} installed={[ECHO]}>
          <Routes>
            <Route path="/m/:moduleId/*" element={<ModulePage />} />
          </Routes>
        </ModulesProvider>
      </MemoryRouter>,
    )
    const link = await screen.findByRole('link', { name: /Ativar em Configs/ })
    expect(link.getAttribute('href')).toBe('/configs?secao=modulos')
  })

  it('Configs → Módulos liga o módulo via PUT e mostra erro de carga', async () => {
    const calls = stubFetch([info({ enabled: false }), info({ id: 'quebrado', name: 'Quebrado', enabled: false, load_error: 'boom' })])
    const c = client()
    render(
      <MemoryRouter>
        <ModulesProvider client={c}>
          <ModulesPanel client={c} />
        </ModulesProvider>
      </MemoryRouter>,
    )
    expect(await screen.findByText(/falhou ao carregar no servidor: boom/)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ativar Echo' }))
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Desativar Echo' })).toBeTruthy())
    const put = calls.find((x) => x.init?.method === 'PUT')!
    expect(put.url).toMatch(/\/modules\/echo$/)
    expect(JSON.parse(String(put.init?.body))).toEqual({ enabled: true })
  })
})
