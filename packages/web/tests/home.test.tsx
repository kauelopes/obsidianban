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

  it('escalação soma no contador de decisões do tile', () => {
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
    expect(screen.getByText(/▲ 1 decisão/)).toBeTruthy()
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

  it('prazo apertado acende o tile sozinho; prazo folgado não', () => {
    // Sem card em review: o alerta do tile tem que vir da meta, não da fila.
    const calm = CARDS.filter((c) => c.status !== 'review')
    const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('sv')
    const goalIn = (days: number) => [
      {
        id: 'goal-1',
        title: 'Entregar relatório',
        target_date: inDays(days),
        status: 'open',
        created_at: '2026-01-01T00:00:00Z',
      },
    ]
    const projects = (goals: object[]) => [
      { project: 'teste', columns: ['backlog', 'todo', 'in_progress', 'review', 'done'], archived: false, sprints: [SPRINT], goals },
    ]

    const soon = renderHome(calm, [], { projects: projects(goalIn(5)) })
    expect(soon.container.querySelector('.pt-goals .goal-due-soon')).toBeTruthy()
    expect(soon.container.querySelector('.project-tile.alert')).toBeTruthy()
    soon.unmount()

    const later = renderHome(calm, [], { projects: projects(goalIn(20)) })
    expect(later.container.querySelector('.pt-goals .goal-due-soon')).toBeNull()
    expect(later.container.querySelector('.project-tile.alert')).toBeNull()
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

  it('sprint ativa aparece com progresso done/total', () => {
    renderHome(CARDS)
    const inSprint = CARDS.filter((c) => c.sprint_id === SPRINT.id)
    const done = inSprint.filter((c) => c.status === 'done').length
    expect(screen.getByText(`${done}/${inSprint.length} done`)).toBeTruthy()
  })
})
