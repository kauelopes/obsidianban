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
  it('renderiza as 5 abas na sidebar, na ordem esperada', () => {
    renderPanel()
    const nav = screen.getByRole('navigation')
    const labels = [...nav.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual([
      'Workflow',
      'Épicos',
      'Agentes',
      'Arquivamento',
      'Deletar projeto',
    ])
  })

  it('abre na aba Workflow por padrão', () => {
    renderPanel()
    expect(screen.getByText('Repositório do workflow')).toBeTruthy()
    expect(screen.queryByText('Épicos do projeto')).toBeNull()
  })

  it('clicar numa aba troca o conteúdo exibido', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Épicos' }))
    expect(screen.getByText('Épicos do projeto')).toBeTruthy()
    expect(screen.queryByText('Repositório do workflow')).toBeNull()
    expect(screen.getByRole('button', { name: 'Épicos' }).classList.contains('active')).toBe(true)
    expect(screen.getByRole('button', { name: 'Workflow' }).classList.contains('active')).toBe(false)
  })

  it('a aba Deletar projeto tem classe própria de risco', () => {
    renderPanel()
    const dangerTab = screen.getByRole('button', { name: 'Deletar projeto' })
    expect(dangerTab.classList.contains('danger-tab')).toBe(true)
  })

  it('pré-preenche o campo de repositório quando o projeto já tem um definido', async () => {
    const client = stubClient({
      listProjects: () =>
        Promise.resolve({
          ok: true as const,
          data: {
            projects: [
              {
                project: 'teste',
                columns: [],
                archived: false,
                goals: [],
                target_repo: '/home/dev/meu-repo',
              },
            ],
          },
        }),
    })
    renderPanel(client)
    const input = await screen.findByPlaceholderText('/caminho/absoluto/para/o/repo')
    expect((input as HTMLInputElement).value).toBe('/home/dev/meu-repo')
  })

  it('deletar continua bloqueado até o nome do projeto ser digitado corretamente', () => {
    renderPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Deletar projeto' }))
    const deleteButton = screen.getByRole('button', { name: 'Deletar' }) as HTMLButtonElement
    expect(deleteButton.disabled).toBe(true)
    const input = screen.getByPlaceholderText('digite “teste” para confirmar')
    fireEvent.change(input, { target: { value: 'errado' } })
    expect(deleteButton.disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'teste' } })
    expect(deleteButton.disabled).toBe(false)
  })
})
