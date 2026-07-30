import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanClient } from '../src/api/client.js'
import { AgentsStatusBar } from '../src/ui/AgentsStatusBar.js'

const STATUS_POLL_MS = 3000
const ACTIVE_SPRINT = {
  id: 'sprint-1',
  name: 'S1',
  goal: null,
  created_at: '2026-01-01T00:00:00.000Z',
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  status: 'active' as const,
  queued_at: null,
}
const RUN = {
  sprint_id: 'sprint-1',
  project: 'p1',
  pid: 123,
  status: 'running' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  exit_code: null,
  stopping_gracefully: false,
}

/**
 * "sem atividade há Xm" agora vem de last_activity_at (mtime do log no
 * servidor), não de crescimento observado no cliente — o servidor detecta
 * idle mesmo que ninguém tenha o painel aberto. Estes testes travam esse
 * comportamento com um servidor fake cujo last_activity_at é fixo.
 */
function mount(lastActivityAt: string) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/workflow/agents')) {
      return {
        status: 200,
        json: async () => ({
          sprint_id: 'sprint-1',
          run: RUN,
          phase: 'dev',
          last_activity_at: lastActivityAt,
          in_progress_cards: [],
        }),
      } as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  return render(
    <AgentsStatusBar client={new KanbanClient({ token: 'tok' })} project="p1" sprints={[ACTIVE_SPRINT]} />,
  )
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AgentsStatusBar — sem sprint ativa', () => {
  it('mostra estado vazio sem chamar o servidor', () => {
    render(<AgentsStatusBar client={new KanbanClient({ token: 'tok' })} project="p1" sprints={[]} />)
    expect(screen.getByText('nenhuma sprint ativa')).toBeTruthy()
  })
})

describe('AgentsStatusBar — aviso de inatividade', () => {
  it('não mostra o aviso antes do limiar de 5min', async () => {
    const now = new Date().toISOString()
    mount(now)
    await waitFor(() => expect(screen.getByText('executando')).toBeTruthy())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    })
    expect(screen.queryByText(/sem atividade há/)).toBeNull()
  })

  it('mostra o aviso depois de 5min sem atividade no servidor', async () => {
    const lastActivityAt = new Date().toISOString()
    mount(lastActivityAt)
    await waitFor(() => expect(screen.getByText('executando')).toBeTruthy())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + STATUS_POLL_MS)
    })
    expect(screen.getByText(/sem atividade há/)).toBeTruthy()
  })
})

describe('AgentsStatusBar — parar (graciosa vs imediata)', () => {
  it('clicar em Parar pede a parada graciosa; depois disso vira Parada imediata', async () => {
    let stoppingGracefully = false
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url.includes('/workflow/agents')) {
        return {
          status: 200,
          json: async () => ({
            sprint_id: 'sprint-1',
            run: { ...RUN, stopping_gracefully: stoppingGracefully },
            phase: 'dev',
            last_activity_at: new Date().toISOString(),
            in_progress_cards: [],
          }),
        } as Response
      }
      if (url.includes('/mcp/tool/kanban_workflow_request_stop')) {
        stoppingGracefully = true
        return {
          status: 200,
          text: async () => JSON.stringify({ ...RUN, stopping_gracefully: true }),
        } as Response
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? ''}`)
    })

    render(
      <AgentsStatusBar client={new KanbanClient({ token: 'tok' })} project="p1" sprints={[ACTIVE_SPRINT]} />,
    )
    await waitFor(() => expect(screen.getByText('Parar')).toBeTruthy())
    expect(screen.queryByText('Parada imediata')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByText('Parar'))
    })

    await waitFor(() => expect(screen.getByText('Parada imediata')).toBeTruthy())
    expect(screen.queryByText('Parar')).toBeNull()
    expect(screen.getByText('parando após esta rodada…')).toBeTruthy()
  })
})
