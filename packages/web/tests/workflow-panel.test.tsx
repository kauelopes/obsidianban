import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanClient } from '../src/api/client.js'
import { WorkflowPanel } from '../src/ui/WorkflowPanel.js'

const POLL_MS = 2500
const RUN = {
  sprint_id: 'sprint-1',
  project: 'p1',
  pid: 123,
  status: 'running' as const,
  started_at: '2026-01-01T00:00:00.000Z',
  ended_at: null,
  exit_code: null,
}

/**
 * "sem atividade há Xm" é derivado de quando o LOG CRESCE, não de quando
 * pollamos — pollar a cada 2.5s sem novas linhas não deveria, sozinho, disparar
 * o aviso. Estes testes travam esse comportamento com um servidor fake cujo
 * log só cresce quando o teste manda.
 */
function mount(logLenFn: () => number) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/mcp/tool/kanban_workflow_status')) {
      return { status: 200, json: async () => ({ sprint_id: 'sprint-1', run: RUN }) } as Response
    }
    if (url.includes('/workflow/log')) {
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? '0')
      const total = logLenFn()
      const data = offset < total ? 'x'.repeat(total - offset) : ''
      return {
        status: 200,
        json: async () => ({ sprint_id: 'sprint-1', run: RUN, size: total, data }),
      } as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  return render(
    <WorkflowPanel client={new KanbanClient({ token: 'tok' })} sprintId="sprint-1" sprintActive={true} />,
  )
}

beforeEach(() => {
  // jsdom não implementa scrollIntoView; o painel chama isto ao montar
  // (rola até a viewport quando abre embaixo da tabela de sprints).
  Element.prototype.scrollIntoView = vi.fn()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('WorkflowPanel — aviso de inatividade', () => {
  it('não mostra o aviso enquanto o log segue crescendo', async () => {
    let total = 0
    mount(() => total)
    await waitFor(() => expect(screen.getByText('executando')).toBeTruthy())

    // 3 minutos de polling, log crescendo a cada tick — bem menos que o
    // limiar de 5min, então mesmo sem "atividade recente" no sentido humano
    // do termo, o log está vivo e o aviso não deve aparecer.
    for (let i = 0; i < 72; i++) {
      total += 10
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_MS)
      })
    }
    expect(screen.queryByText(/sem atividade há/)).toBeNull()
  })

  it('mostra o aviso depois de 5min sem o log crescer', async () => {
    const total = 100
    mount(() => total)
    await waitFor(() => expect(screen.getByText('executando')).toBeTruthy())

    // Log já leu tudo no primeiro poll (offset alcança `total`) — dali em
    // diante nenhum poll traz linha nova, simulando um harness travado.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + POLL_MS)
    })
    expect(screen.getByText(/sem atividade há/)).toBeTruthy()
  })

  it('não mostra o aviso enquanto ainda não passou o limiar', async () => {
    const total = 100
    mount(() => total)
    await waitFor(() => expect(screen.getByText('executando')).toBeTruthy())

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    })
    expect(screen.queryByText(/sem atividade há/)).toBeNull()
  })
})
