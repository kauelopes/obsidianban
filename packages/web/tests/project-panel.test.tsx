import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { KanbanClient } from '../src/api/client.js'
import { ProjectPanel } from '../src/ui/ProjectPanel.js'

function stubClient(overrides: Partial<KanbanClient> = {}): KanbanClient {
  const base = {
    listProjects: () =>
      Promise.resolve({
        ok: true as const,
        data: { projects: [{ project: 'teste', goals: [] }] },
      }),
    listEpics: () => Promise.resolve({ ok: true as const, data: { project: 'teste', epics: [] } }),
    setProjectRepo: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
    createAgentToken: () => Promise.resolve({ ok: false as const, error: { kind: 'network' } }),
    deleteProject: () => Promise.resolve({ ok: true as const, data: { project: 'teste' } }),
    archiveProject: () => Promise.resolve({ ok: true as const, data: { project: 'teste' } }),
    unarchiveProject: () => Promise.resolve({ ok: true as const, data: { project: 'teste' } }),
    ...overrides,
  }
  return base as unknown as KanbanClient
}

function renderPanel(client: KanbanClient = stubClient()) {
  return render(
    <ProjectPanel client={client} project="teste" onClose={() => {}} onChanged={() => {}} />,
  )
}

describe('ProjectPanel', () => {
  it('renderiza os 5 blocos com títulos, na ordem esperada', () => {
    const { container } = renderPanel()
    const headings = [...container.querySelectorAll('.panel-section > h3')].map(
      (h) => h.textContent,
    )
    expect(headings).toEqual([
      'Workflow',
      'Planejamento do projeto',
      'Agentes e tokens',
      'Arquivamento',
      'Zona destrutiva',
    ])
  })

  it('a zona destrutiva é o último bloco e tem sua própria classe', () => {
    const { container } = renderPanel()
    const sections = container.querySelectorAll('.panel-section')
    const last = sections[sections.length - 1]!
    expect(last.classList.contains('panel-section--danger')).toBe(true)
    expect(last.querySelector('button.danger')?.textContent).toBe('Deletar')
  })

  it('deletar continua bloqueado até o nome do projeto ser digitado corretamente', () => {
    renderPanel()
    const deleteButton = screen.getByRole('button', { name: 'Deletar' }) as HTMLButtonElement
    expect(deleteButton.disabled).toBe(true)
    const input = screen.getByPlaceholderText('digite “teste” para confirmar')
    fireEvent.change(input, { target: { value: 'errado' } })
    expect(deleteButton.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'teste' } })
    expect(deleteButton.disabled).toBe(false)
  })
})
