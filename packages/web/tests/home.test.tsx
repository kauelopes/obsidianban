import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { CardSummary, EscalationItem, Sprint } from '@obsidiankan/types'
import type { KanbanClient } from '../src/api/client.js'
import type { useBoard } from '../src/board/useBoard.js'
import { Home } from '../src/home/Home.js'
import getSprintJson from './fixtures/get_sprint.json'
import activityJson from './fixtures/activity.json'

const CARDS = getSprintJson.cards as unknown as CardSummary[]
const SPRINT = getSprintJson.sprint as unknown as Sprint

// O suficiente da superfície do client/useBoard para a Home renderizar.
// ok:false em tudo: sem setState assíncrono, os testes síncronos não avisam act().
const offline = {
  getMetrics: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
  listCards: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
  getActivity: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
  planningList: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
}
const client = offline as unknown as KanbanClient

function boardStub(
  cards: readonly CardSummary[],
  escalations: readonly EscalationItem[],
  projects: object[] = [
    { project: 'teste', columns: ['backlog', 'todo', 'in_progress', 'review', 'done'], archived: false, sprints: [SPRINT] },
  ],
): ReturnType<typeof useBoard> {
  return { cards, escalations, projects, loading: false } as unknown as ReturnType<
    typeof useBoard
  >
}

function renderHome(
  cards: readonly CardSummary[],
  escalations: readonly EscalationItem[] = [],
  opts: { client?: KanbanClient; onCreateProject?: () => void; projects?: object[] } = {},
) {
  return render(
    <MemoryRouter>
      <Home
        client={opts.client ?? client}
        board={boardStub(cards, escalations, opts.projects)}
        onCreateProject={opts.onCreateProject ?? (() => {})}
      />
    </MemoryRouter>,
  )
}

describe('Home', () => {
  it('o tile do projeto é um link para o board dele', () => {
    const { container } = renderHome(CARDS)
    const tile = container.querySelector('a.project-tile')
    expect(tile?.getAttribute('href')).toBe('/board/teste')
  })

  it('cards em review entram na fila "precisa de você" com glifo e palavra', () => {
    renderHome(CARDS)
    // O fixture tem exatamente 1 card em review.
    expect(screen.getByText(/● review/)).toBeTruthy()
    expect(screen.getByText(/precisa de você/)).toBeTruthy()
  })

  it('sem review nem escalação, o all-clear abre a página no lugar da fila', () => {
    const semReview = CARDS.filter((c) => c.status !== 'review')
    renderHome(semReview)
    expect(screen.queryByText(/precisa de você/)).toBeNull()
    expect(screen.getByText('Nada esperando você.')).toBeTruthy()
  })

  it('badge no título da aba reflete a fila de decisão', () => {
    const { unmount } = renderHome(CARDS)
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
    renderHome(semReview, [], { client: snapClient })
    expect(await screen.findByText('review invisível ao board')).toBeTruthy()
  })

  it('fila ordena review por prioridade e mostra há quanto tempo espera', () => {
    const review = CARDS.find((c) => c.status === 'review')!
    // Mesma prioridade do fixture (critical): o desempate é quem espera há mais.
    const urgente = {
      ...review,
      id: 'card-urgente1',
      title: 'urgente',
      updated_at: '2026-01-01T00:00:00Z',
    }
    renderHome([...CARDS, urgente])
    const titles = [...document.querySelectorAll('.pending strong')].map((el) => el.textContent)
    expect(titles[0]).toBe('urgente')
    expect(screen.getAllByText(/esperando há/).length).toBeGreaterThan(0)
  })

  it('hub: aside vem antes da main no DOM e abriga a fila de decisão', () => {
    const { container } = renderHome(CARDS)
    const grid = container.querySelector('.home-grid')!
    expect(grid.children[0]!.classList.contains('home-side')).toBe(true)
    expect(grid.children[1]!.classList.contains('home-main')).toBe(true)
    expect(container.querySelector('.home-side .needs-you')).toBeTruthy()
    expect(container.querySelector('.home-main .project-grid')).toBeTruthy()
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
    const { container } = renderHome(CARDS, [], { client: planClient })
    expect(await screen.findByText('meu-app')).toBeTruthy()
    const link = container.querySelector('.home-side .home-plan a')
    expect(link?.getAttribute('href')).toBe('/planejar/plan-abc12345')
    expect(screen.getByText(/etapa 8 de 15 — Módulos/)).toBeTruthy()
  })

  it('empty state de projetos oferece a criação ali mesmo', () => {
    let opened = false
    renderHome([], [], { onCreateProject: () => (opened = true), projects: [] })
    screen.getByText('+ criar o primeiro projeto').click()
    expect(opened).toBe(true)
  })

  it('com /activity respondendo, o tile ganha sparkline e horas estimadas', async () => {
    const actClient = {
      ...offline,
      getActivity: () => Promise.resolve({ ok: true as const, data: activityJson }),
    } as unknown as KanbanClient
    const { container } = renderHome(CARDS, [], { client: actClient })
    expect(await screen.findByText('≈ 3,5 h na semana')).toBeTruthy()
    expect(container.querySelector('svg.sparkline')).toBeTruthy()
  })

  it('meta aberta aparece no tile; vencida entra no canal de alerta', () => {
    const goals = [
      { id: 'goal-1', title: 'Lançar v1', target_date: '2020-01-01', status: 'open', created_at: '2026-01-01T00:00:00Z' },
      { id: 'goal-2', title: 'Meta concluída', target_date: null, status: 'done', created_at: '2026-01-01T00:00:00Z' },
    ]
    const { container } = renderHome(CARDS, [], {
      projects: [
        { project: 'teste', columns: ['backlog', 'todo', 'in_progress', 'review', 'done'], archived: false, sprints: [SPRINT], goals },
      ],
    })
    expect(screen.getByText(/Lançar v1/)).toBeTruthy()
    // Concluída não polui o tile — a home só mostra metas abertas.
    expect(screen.queryByText(/Meta concluída/)).toBeNull()
    const overdue = container.querySelector('.pt-goals .goal-overdue')
    expect(overdue?.textContent).toContain('venceu')
  })

  it('muitas sprints em planning viram resumo de uma linha, não lista', () => {
    const planned = Array.from({ length: 6 }, (_, i) => ({
      id: `sprint-plan${i}`,
      name: `Sprint planejada ${i + 1}`,
      status: 'planning',
      goal: null,
    }))
    renderHome(CARDS, [], {
      projects: [
        { project: 'teste', columns: ['backlog', 'todo', 'in_progress', 'review', 'done'], archived: false, sprints: [SPRINT, ...planned] },
      ],
    })
    // Só a próxima aparece; o resto vira contador (lista completa no title).
    expect(screen.getByText('Sprint planejada 1')).toBeTruthy()
    expect(screen.getByText('+5 sprints')).toBeTruthy()
    expect(screen.queryByText('Sprint planejada 2')).toBeNull()
  })

  it('escalação mostra motivo e projeto', () => {
    const semReview = CARDS.filter((c) => c.status !== 'review')
    renderHome(semReview, [
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
    expect(screen.getByText(/▲ escalado/)).toBeTruthy()
    expect(screen.getByText(/preciso de uma decisão de escopo/)).toBeTruthy()
  })

  it('sprint ativa aparece com progresso done/total', () => {
    renderHome(CARDS)
    const inSprint = CARDS.filter((c) => c.sprint_id === SPRINT.id)
    const done = inSprint.filter((c) => c.status === 'done').length
    expect(screen.getByText(`${done}/${inSprint.length} done`)).toBeTruthy()
  })
})
