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

const NOT_RUNNING = {
  ...RUN,
  status: 'exited' as const,
  pid: null,
  ended_at: '2026-01-01T00:05:00.000Z',
  exit_code: 0,
}

function mountAgentsPayload(payload: Record<string, unknown>) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/workflow/agents')) {
      return { status: 200, json: async () => payload } as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  return render(
    <AgentsStatusBar client={new KanbanClient({ token: 'tok' })} project="p1" sprints={[ACTIVE_SPRINT]} />,
  )
}

describe('AgentsStatusBar — jobs em background bloqueiam "Executar agentes"', () => {
  it('desabilita o botão e mostra a explicação quando há job running', async () => {
    mountAgentsPayload({
      sprint_id: 'sprint-1',
      run: NOT_RUNNING,
      phase: 'idle',
      last_activity_at: null,
      in_progress_cards: [],
      jobs: [
        {
          job_id: 'job-1',
          card_id: 'card-1',
          sprint_id: 'sprint-1',
          project: 'p1',
          command: 'uv run pytest',
          pid: 111,
          status: 'running',
          started_at: '2026-01-01T00:00:00.000Z',
          last_output_at: '2026-01-01T00:00:00.000Z',
          claimed_by: 'workflow:dev',
          stalled: false,
        },
      ],
    })

    const button = await waitFor(() => screen.getByText('Executar agentes'))
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/job\(s\) em execução — aguardando/)).toBeTruthy()
  })

  it('sinaliza job stalled distintamente', async () => {
    mountAgentsPayload({
      sprint_id: 'sprint-1',
      run: NOT_RUNNING,
      phase: 'idle',
      last_activity_at: null,
      in_progress_cards: [],
      jobs: [
        {
          job_id: 'job-1',
          card_id: 'card-1',
          sprint_id: 'sprint-1',
          project: 'p1',
          command: 'uv run pytest',
          pid: 111,
          status: 'running',
          started_at: '2026-01-01T00:00:00.000Z',
          last_output_at: '2026-01-01T00:00:00.000Z',
          claimed_by: 'workflow:dev',
          stalled: true,
        },
      ],
    })

    await waitFor(() => expect(screen.getByText(/job sem saída/)).toBeTruthy())
  })

  it('habilita o botão quando o único job é terminal (succeeded)', async () => {
    mountAgentsPayload({
      sprint_id: 'sprint-1',
      run: NOT_RUNNING,
      phase: 'idle',
      last_activity_at: null,
      in_progress_cards: [],
      jobs: [
        {
          job_id: 'job-1',
          card_id: 'card-1',
          sprint_id: 'sprint-1',
          project: 'p1',
          command: 'uv run pytest',
          pid: null,
          status: 'succeeded',
          started_at: '2026-01-01T00:00:00.000Z',
          ended_at: '2026-01-01T00:01:00.000Z',
          exit_code: 0,
          last_output_at: '2026-01-01T00:00:59.000Z',
          claimed_by: 'workflow:dev',
        },
      ],
    })

    const button = await waitFor(() => screen.getByText('Executar agentes'))
    expect((button as HTMLButtonElement).disabled).toBe(false)
    expect(screen.queryByText(/job\(s\) em execução/)).toBeNull()
  })

  it('payload legado sem `jobs` não quebra — botão habilitado', async () => {
    mountAgentsPayload({
      sprint_id: 'sprint-1',
      run: NOT_RUNNING,
      phase: 'idle',
      last_activity_at: null,
      in_progress_cards: [],
    })

    const button = await waitFor(() => screen.getByText('Executar agentes'))
    expect((button as HTMLButtonElement).disabled).toBe(false)
  })

  it('reage a JOB_FINISHED via SSE — reconsulta e libera o botão sem esperar o poll', async () => {
    let running = true
    let sseHandler: ((ev: MessageEvent) => void) | undefined
    class FakeEventSource {
      static CLOSED = 2
      readyState = 1
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        if (type === 'JOB_FINISHED') sseHandler = listener as (ev: MessageEvent) => void
      }
      removeEventListener() {}
      close() {}
    }
    const originalEventSource = window.EventSource
    // @ts-expect-error stub replaces the inert EventSource from tests/setup.ts
    window.EventSource = FakeEventSource

    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/workflow/agents')) {
        return {
          status: 200,
          json: async () => ({
            sprint_id: 'sprint-1',
            run: NOT_RUNNING,
            phase: 'idle',
            last_activity_at: null,
            in_progress_cards: [],
            jobs: running
              ? [
                  {
                    job_id: 'job-1',
                    card_id: 'card-1',
                    sprint_id: 'sprint-1',
                    project: 'p1',
                    command: 'uv run pytest',
                    pid: 111,
                    status: 'running',
                    started_at: '2026-01-01T00:00:00.000Z',
                    last_output_at: '2026-01-01T00:00:00.000Z',
                    claimed_by: 'workflow:dev',
                    stalled: false,
                  },
                ]
              : [],
          }),
        } as Response
      }
      throw new Error(`unexpected fetch: ${url}`)
    })

    render(
      <AgentsStatusBar client={new KanbanClient({ token: 'tok' })} project="p1" sprints={[ACTIVE_SPRINT]} />,
    )

    const button = await waitFor(() => screen.getByText('Executar agentes'))
    expect((button as HTMLButtonElement).disabled).toBe(true)

    running = false
    await act(async () => {
      sseHandler?.({ data: '' } as MessageEvent)
    })

    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
    window.EventSource = originalEventSource
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
