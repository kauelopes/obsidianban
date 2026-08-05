import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { CardSummary, EscalationItem, Sprint, WeeklyDigest } from '@obsidiankan/types'
import type { KanbanClient } from '../src/api/client.js'
import type { useBoard } from '../src/board/useBoard.js'
import { Dashboard } from '../src/home/Dashboard.js'
import getSprintJson from './fixtures/get_sprint.json'

const CARDS = getSprintJson.cards as unknown as CardSummary[]
const SPRINT = getSprintJson.sprint as unknown as Sprint

function digest(over: Partial<WeeklyDigest> = {}): WeeklyDigest {
  return {
    week_start: '2026-06-29',
    week_end: '2026-07-05',
    sprints_closed: [],
    cards_done: [],
    goals_done: [],
    goals_upcoming: [],
    stalled_reviews: [],
    activity: { summary: { total_input_tokens: 0, total_output_tokens: 0, total_cache_read_tokens: 0, total_cache_creation_tokens: 0, total_cost_usd: 0, total_ops: 0 }, by_day: [], by_project: [] },
    hours_estimate: 0,
    hours_estimate_available: true,
    audit_truncated: false,
    ...over,
  }
}

// ok:false em tudo por padrão: sem setState assíncrono, os testes síncronos não avisam act().
const offline = {
  listCards: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
  getDigest: () => Promise.resolve({ ok: true as const, data: digest() }),
  planningList: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
  workflowStatus: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
}
const client = offline as unknown as KanbanClient

function boardStub(
  cards: readonly CardSummary[],
  escalations: readonly EscalationItem[],
  projects: object[] = [
    { project: 'teste', columns: ['backlog', 'todo', 'in_progress', 'review', 'done'], archived: false, sprints: [SPRINT] },
  ],
): ReturnType<typeof useBoard> {
  return { cards, escalations, projects, loading: false, reload: () => {} } as unknown as ReturnType<
    typeof useBoard
  >
}

function renderDashboard(
  cards: readonly CardSummary[],
  escalations: readonly EscalationItem[] = [],
  opts: { client?: KanbanClient; projects?: object[] } = {},
) {
  return render(
    <MemoryRouter>
      <Dashboard client={opts.client ?? client} board={boardStub(cards, escalations, opts.projects)} />
    </MemoryRouter>,
  )
}

describe('Dashboard', () => {
  it('cards em review entram na fila "precisa de você"', () => {
    const { container } = renderDashboard(CARDS)
    // O fixture tem exatamente 1 card em review.
    expect(screen.getByText(/● review/)).toBeTruthy()
    expect(container.querySelector('.needs-you .label')?.textContent).toContain('precisa de você')
  })

  it('sem review nem escalação, o all-clear abre a página no lugar da fila', () => {
    const semReview = CARDS.filter((c) => c.status !== 'review')
    const { container } = renderDashboard(semReview)
    expect(container.querySelector('.needs-you')).toBeNull()
    expect(screen.getByText('Nada esperando você.')).toBeTruthy()
  })

  it('badge no título da aba reflete a fila de decisão', () => {
    const { unmount } = renderDashboard(CARDS)
    expect(document.title).toBe('(1) ObsidianKan')
    unmount()
    expect(document.title).toBe('ObsidianKan')
  })

  it('card em review fora da janela do board entra na fila via snapshot dedicado', async () => {
    const semReview = CARDS.filter((c) => c.status !== 'review')
    const foraDaJanela = {
      ...CARDS.find((c) => c.status === 'review')!,
      id: 'card-fora0001',
      title: 'review invisível ao board',
    }
    const snapClient = {
      ...offline,
      listCards: () => Promise.resolve({ ok: true as const, data: { cards: [foraDaJanela] } }),
    } as unknown as KanbanClient
    renderDashboard(semReview, [], { client: snapClient })
    expect(await screen.findByText('review invisível ao board')).toBeTruthy()
  })

  it('escalação mostra motivo e projeto, com ação de responder', () => {
    const semReview = CARDS.filter((c) => c.status !== 'review')
    renderDashboard(semReview, [
      {
        card_id: semReview[0]!.id,
        project: 'teste',
        title: semReview[0]!.title,
        status: 'in_progress',
        version: 1,
        priority: 'high',
        assigned_to: null,
        updated_at: '2026-06-01T00:00:00Z',
        escalated_at: null,
        reason: 'preciso de uma decisão de escopo',
      },
    ])
    expect(screen.getByText('preciso de uma decisão de escopo')).toBeTruthy()
    expect(screen.getByText('Responder')).toBeTruthy()
  })

  it('sessão de planejamento ativa vira card retomável no aside', async () => {
    const planClient = {
      ...offline,
      planningList: () =>
        Promise.resolve({
          ok: true as const,
          data: {
            sessions: [
              {
                session_id: 'plan-abc12345',
                status: 'awaiting_user',
                current_step: 'modules',
                project_name: 'meu-app',
              },
            ],
          },
        }),
    } as unknown as KanbanClient
    const { container } = renderDashboard(CARDS, [], { client: planClient })
    expect(await screen.findByText('meu-app')).toBeTruthy()
    const link = container.querySelector('.home-side .home-plan a')
    expect(link?.getAttribute('href')).toBe('/planejar/plan-abc12345')
  })

  it('projeto com agente rodando aparece na lista de "agentes trabalhando"', async () => {
    const workingClient = {
      ...offline,
      workflowStatus: () =>
        Promise.resolve({ ok: true as const, data: { run: { status: 'running' } } }),
    } as unknown as KanbanClient
    renderDashboard(CARDS, [], { client: workingClient })
    expect(await screen.findByText('teste')).toBeTruthy()
    expect(screen.getAllByText(/agentes trabalhando/).length).toBeGreaterThan(0)
  })

  it('sem agente rodando, avisa que não há nada em execução', () => {
    renderDashboard(CARDS)
    expect(screen.getByText('Nenhum agente rodando agora.')).toBeTruthy()
  })

  it('meta vencida aparece em "próximas metas"', () => {
    const goals = [
      { id: 'goal-1', title: 'Lançar v1', target_date: '2020-01-01', status: 'open', created_at: '2026-01-01T00:00:00Z' },
    ]
    renderDashboard(CARDS, [], {
      projects: [
        { project: 'teste', columns: ['backlog', 'todo', 'in_progress', 'review', 'done'], archived: false, sprints: [SPRINT], goals },
      ],
    })
    expect(screen.getByText('Lançar v1')).toBeTruthy()
  })

  it('resumo da semana mostra os tiles do digest', async () => {
    const digestClient = {
      ...offline,
      getDigest: () =>
        Promise.resolve({
          ok: true as const,
          data: digest({
            sprints_closed: [{ project: 'teste', sprint_id: 's1', name: 'Sprint 1', goal: null, ended_at: '2026-07-01T00:00:00Z' }],
          }),
        }),
    } as unknown as KanbanClient
    renderDashboard(CARDS, [], { client: digestClient })
    expect(await screen.findByText('sprints fechadas')).toBeTruthy()
    expect(screen.getByText('1')).toBeTruthy()
  })
})
