import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { KanbanClient } from '../src/api/client.js'
import { Horizon } from '../src/horizon/Horizon.js'

const TODAY = new Date().toLocaleDateString('sv')
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toLocaleDateString('sv')

function goal(id: string, title: string, target_date: string | null, status = 'open') {
  return { id, title, target_date, status, created_at: '2026-01-01T00:00:00Z' }
}

const PROJECTS = {
  projects: [
    {
      project: 'alpha',
      columns: [],
      archived: false,
      goals: [
        goal('g-atrasada', 'Publicar changelog', inDays(-5)),
        goal('g-feita', 'Meta já concluída', inDays(3), 'done'),
      ],
    },
    {
      project: 'beta',
      columns: [],
      archived: false,
      goals: [
        goal('g-curta', 'Fechar contrato', inDays(3)),
        goal('g-longa', 'Migrar infra', inDays(90)),
        goal('g-sem-data', 'Estudar concorrentes', null),
      ],
    },
    {
      project: 'antigo',
      columns: [],
      archived: true,
      goals: [goal('g-arquivada', 'Meta de projeto arquivado', inDays(2))],
    },
  ],
}

function jsonResponse(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body), json: async () => body } as Response
}

function mount(opts: { projects?: unknown; projectsStatus?: number; onSetGoal?: (body: string) => void } = {}) {
  const projects = opts.projects ?? PROJECTS
  const projectsStatus = opts.projectsStatus ?? 200
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/mcp/tool/kanban_list_projects')) return jsonResponse(projectsStatus, projects)
    if (url.includes('/mcp/tool/kanban_set_goal')) {
      opts.onSetGoal?.(String(init?.body ?? ''))
      return jsonResponse(200, { project: 'alpha', goal: goal('g-atrasada', 'x', null, 'done') })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  const view = render(
    <MemoryRouter>
      <Horizon client={new KanbanClient({ token: 'tok' })} />
    </MemoryRouter>,
  )
  // O título de uma meta aparece duas vezes de propósito — na lista e na
  // célula do calendário. Escopar na lista mantém as queries sem ambiguidade.
  const list = () => within(view.container.querySelector('.home-side') as HTMLElement)
  return { ...view, list }
}

describe('Horizon', () => {
  it('agrupa as metas por horizonte, atravessando projetos', async () => {
    const { list } = mount()
    await waitFor(() => expect(screen.getByText('atrasadas')).toBeTruthy())
    expect(screen.getByText('curto prazo — até 2 semanas')).toBeTruthy()
    expect(screen.getByText('longo prazo — mais de 4 semanas')).toBeTruthy()
    expect(screen.getByText('sem prazo')).toBeTruthy()
    // Sem metas entre 15 e 28 dias no fixture — o grupo não aparece vazio.
    expect(screen.queryByText('médio prazo — 2 a 4 semanas')).toBeNull()

    expect(list().getByText('Publicar changelog')).toBeTruthy()
    expect(list().getByText('Fechar contrato')).toBeTruthy()
  })

  it('não mostra meta concluída nem meta de projeto arquivado', async () => {
    const { list } = mount()
    await waitFor(() => expect(list().getByText('Publicar changelog')).toBeTruthy())
    expect(screen.queryByText('Meta já concluída')).toBeNull()
    expect(screen.queryByText('Meta de projeto arquivado')).toBeNull()
  })

  it('a meta atrasada entra no canal de alerta', async () => {
    const { container, list } = mount()
    await waitFor(() => expect(list().getByText('Publicar changelog')).toBeTruthy())
    const overdue = container.querySelector('.horizon-list .goal-overdue')
    expect(overdue?.textContent).toContain('Publicar changelog')
  })

  it('concluir chama kanban_set_goal com status done e recarrega', async () => {
    let body = ''
    const { list } = mount({ onSetGoal: (b) => (body = b) })
    await waitFor(() => expect(list().getByText('Publicar changelog')).toBeTruthy())
    screen.getAllByText('concluir')[0]!.click()
    await waitFor(() => expect(body).not.toBe(''))
    const parsed = JSON.parse(body)
    expect(parsed.status).toBe('done')
    expect(parsed.id).toBe('g-atrasada')
    expect(parsed.project).toBe('alpha')
  })

  it('meta sem prazo oferece definir prazo, e salvar manda a data', async () => {
    let body = ''
    const { container, list } = mount({ onSetGoal: (b) => (body = b) })
    await waitFor(() => expect(list().getByText('Estudar concorrentes')).toBeTruthy())

    // Só a meta sem prazo ganha o botão — as datadas mostram a data.
    expect(screen.getAllByText('definir prazo')).toHaveLength(1)
    screen.getByText('definir prazo').click()

    const input = await waitFor(() => {
      const el = container.querySelector('input[type="date"]') as HTMLInputElement
      expect(el).toBeTruthy()
      return el
    })
    // Não deixa marcar prazo no passado.
    expect(input.min).toBe(TODAY)

    fireEvent.change(input, { target: { value: '2026-12-01' } })
    await waitFor(() => expect(body).not.toBe(''))
    const parsed = JSON.parse(body)
    expect(parsed.target_date).toBe('2026-12-01')
    expect(parsed.id).toBe('g-sem-data')
    expect(parsed.project).toBe('beta')
    // Sem status no payload: definir prazo não pode fechar a meta sem querer.
    expect(parsed.status).toBeUndefined()
  })

  it('navegar de mês troca o rótulo do calendário', async () => {
    const { container, list } = mount()
    await waitFor(() => expect(list().getByText('Publicar changelog')).toBeTruthy())
    const month = () => container.querySelector('.horizon-month')!.textContent
    const before = month()
    screen.getByLabelText('Próximo mês').click()
    await waitFor(() => expect(month()).not.toBe(before))
    screen.getByLabelText('Mês anterior').click()
    await waitFor(() => expect(month()).toBe(before))
  })

  it('clicar num dia com meta filtra a lista, e o chip limpa o filtro', async () => {
    const { container, list } = mount({
      projects: {
        projects: [
          {
            project: 'alpha',
            columns: [],
            archived: false,
            goals: [goal('g-hoje', 'Vence hoje', TODAY), goal('g-longe', 'Vence longe', inDays(60))],
          },
        ],
      },
    })
    await waitFor(() => expect(list().getByText('Vence hoje')).toBeTruthy())
    expect(list().getByText('Vence longe')).toBeTruthy()

    const cell = container.querySelector('.horizon-cell.today.has-goals') as HTMLElement
    expect(cell).toBeTruthy()
    cell.click()

    await waitFor(() => expect(list().queryByText('Vence longe')).toBeNull())
    expect(list().getByText('Vence hoje')).toBeTruthy()

    const chip = container.querySelector('.horizon-chip') as HTMLElement
    chip.click()
    await waitFor(() => expect(list().getByText('Vence longe')).toBeTruthy())
  })

  it('token sem kanban_list_projects mostra explicação em vez de quebrar', async () => {
    mount({ projectsStatus: 403, projects: { error: 'forbidden' } })
    await waitFor(() => expect(screen.getByText(/precisa de um token de manager/)).toBeTruthy())
  })

  it('vault sem metas abertas mostra estado vazio', async () => {
    mount({ projects: { projects: [{ project: 'alpha', columns: [], archived: false, goals: [] }] } })
    await waitFor(() => expect(screen.getByText(/Nenhuma meta aberta/)).toBeTruthy())
  })
})
