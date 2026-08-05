import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { KanbanClient } from '../src/api/client.js'
import type { useBoard } from '../src/board/useBoard.js'
import { GoalsTab } from '../src/project/GoalsTab.js'
import type { ProjectOutletContext } from '../src/project/ProjectLayout.js'

function stubClient(overrides: Partial<KanbanClient> = {}): KanbanClient {
  const base = {
    listProjects: () =>
      Promise.resolve({
        ok: true as const,
        data: {
          projects: [
            {
              project: 'teste',
              goals: [{ id: 'goal-1', title: 'Lançar v1', target_date: null, status: 'open', created_at: '2026-01-01T00:00:00Z' }],
            },
          ],
        },
      }),
    setGoal: () =>
      Promise.resolve({
        ok: true as const,
        data: {
          project: 'teste',
          goal: { id: 'goal-1', title: '', target_date: null, status: 'open', created_at: '2026-01-01T00:00:00Z' },
        },
      }),
    deleteGoal: () => Promise.resolve({ ok: true as const, data: { project: 'teste' } }),
    ...overrides,
  }
  return base as unknown as KanbanClient
}

// GoalsTab lê o projeto/client via useOutletContext — um layout mínimo com
// <Outlet context={...}/> reproduz exatamente o que ProjectLayout monta.
function LayoutStub({ context }: { context: ProjectOutletContext }) {
  return <Outlet context={context} />
}

function renderGoalsTab(client: KanbanClient = stubClient()) {
  const context: ProjectOutletContext = {
    client,
    project: 'teste',
    board: { reload: () => {} } as unknown as ReturnType<typeof useBoard>,
    sprintsFor: () => [],
    cardsFor: () => [],
    knownProjects: ['teste'],
  }
  return render(
    <MemoryRouter initialEntries={['/board/teste/metas']}>
      <Routes>
        <Route path="/board/:project" element={<LayoutStub context={context} />}>
          <Route path="metas" element={<GoalsTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('GoalsTab', () => {
  it('lista as metas do projeto', async () => {
    renderGoalsTab()
    expect(await screen.findByText('Lançar v1')).toBeTruthy()
  })

  it('cria uma meta nova', async () => {
    let called: unknown = null
    const client = stubClient({
      setGoal: (params) => {
        called = params
        return Promise.resolve({
          ok: true as const,
          data: {
            project: 'teste',
            goal: { id: 'goal-2', title: params.title ?? '', target_date: params.target_date ?? null, status: 'open', created_at: '2026-01-01T00:00:00Z' },
          },
        })
      },
    })
    renderGoalsTab(client)
    await screen.findByText('Lançar v1')
    fireEvent.change(screen.getByPlaceholderText('ex. Lançar a v1 pública'), {
      target: { value: 'Nova meta' },
    })
    fireEvent.click(screen.getByText('Adicionar meta'))
    await waitFor(() => expect(called).toMatchObject({ project: 'teste', title: 'Nova meta' }))
  })
})
