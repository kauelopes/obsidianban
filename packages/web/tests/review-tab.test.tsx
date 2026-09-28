import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { WeeklyDigest } from '@obsidiankan/types'
import { KanbanClient } from '../src/api/client.js'
import { ReviewTab } from '../src/metrics/Metrics.js'
import { mondayOf, todayIso } from '../src/util/time.js'

const THIS_WEEK = mondayOf(todayIso())

function digest(over: Partial<WeeklyDigest> = {}): WeeklyDigest {
  return {
    week_start: THIS_WEEK,
    week_end: THIS_WEEK,
    sprints_closed: [
      { project: 'alfa', sprint_id: 'sprint-1', name: 'Sprint 7', goal: 'Fechar o onboarding', ended_at: '2026-07-08T10:00:00Z' },
    ],
    cards_done: [{ project: 'alfa', card_id: 'card-1', title: 'Implementar login', ts: '2026-07-08T10:00:00Z' }],
    goals_done: [{ project: 'beta', goal_id: 'goal-1', title: 'Publicar beta', ts: '2026-07-09T10:00:00Z' }],
    goals_upcoming: [{ project: 'beta', goal_id: 'goal-2', title: 'Rodar piloto', target_date: '2026-07-15' }],
    stalled_reviews: [
      { project: 'alfa', card_id: 'card-9', title: 'Decidir formato do export', escalated_at: '2026-07-01T10:00:00Z', days_stalled: 6 },
    ],
    activity: {
      summary: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_cache_read_tokens: 0,
        total_cache_creation_tokens: 0,
        total_cost_usd: 1.25,
        total_ops: 3,
      },
      by_day: [],
      by_project: [],
    },
    hours_estimate: 12.5,
    hours_estimate_available: true,
    audit_truncated: false,
    ...over,
  }
}

function mount(opts: { body?: unknown; status?: number; onRequest?: (url: string) => void } = {}) {
  const body = opts.body ?? digest()
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/digest')) {
      opts.onRequest?.(url)
      return {
        status: opts.status ?? 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      } as Response
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  return render(
    <MemoryRouter>
      <ReviewTab client={new KanbanClient({ token: 'tok' })} />
    </MemoryRouter>,
  )
}

describe('ReviewTab', () => {
  it('mostra cada seção da semana', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('Sprint 7')).toBeTruthy())
    expect(screen.getByText('Implementar login')).toBeTruthy()
    expect(screen.getByText('Publicar beta')).toBeTruthy()
    expect(screen.getByText('Rodar piloto')).toBeTruthy()
    expect(screen.getByText('Decidir formato do export')).toBeTruthy()
    expect(screen.getByText('≈ 12,5 h')).toBeTruthy()
    expect(screen.getByText('US$ 1.25')).toBeTruthy()
  })

  it('seção sem itens explica o vazio em vez de sumir', async () => {
    mount({ body: digest({ sprints_closed: [], cards_done: [] }) })
    await waitFor(() => expect(screen.getByText(/Nenhuma sprint fechou/)).toBeTruthy())
    expect(screen.getByText(/Nenhum card entrou em done/)).toBeTruthy()
  })

  it('navegar para a semana anterior refaz a busca com o novo week_start', async () => {
    const urls: string[] = []
    mount({ onRequest: (u) => urls.push(u) })
    await waitFor(() => expect(urls).toHaveLength(1))
    expect(urls[0]).toContain(`week_start=${THIS_WEEK}`)

    screen.getByLabelText('Semana anterior').click()
    await waitFor(() => expect(urls).toHaveLength(2))
    // Sete dias antes da segunda desta semana.
    const prev = new Date(Date.parse(`${THIS_WEEK}T00:00:00Z`) - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    expect(urls[1]).toContain(`week_start=${prev}`)
  })

  it('não deixa navegar para o futuro', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('Sprint 7')).toBeTruthy())
    expect((screen.getByLabelText('Próxima semana') as HTMLButtonElement).disabled).toBe(true)
  })

  it('semana passada não mostra horas e avisa o porquê', async () => {
    mount({ body: digest({ hours_estimate: 0, hours_estimate_available: false }) })
    await waitFor(() => expect(screen.getByText('Sprint 7')).toBeTruthy())
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText(/só existe para a semana corrente/)).toBeTruthy()
  })

  it('avisa quando o log de auditoria foi truncado', async () => {
    mount({ body: digest({ audit_truncated: true }) })
    await waitFor(() => expect(screen.getByText(/lido só até o limite/)).toBeTruthy())
  })

  it('erro do servidor vira banner em vez de tela em branco', async () => {
    mount({ status: 500, body: { error: 'internal_error', message: 'boom' } })
    await waitFor(() => expect(document.querySelector('.banner')).toBeTruthy())
  })
})
