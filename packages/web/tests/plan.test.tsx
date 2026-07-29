import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { PlanningSessionView } from '@obsidiankan/types'
import type { KanbanClient } from '../src/api/client.js'
import { Shell } from '../src/App.js'
import { PlanWizard } from '../src/plan/PlanWizard.js'
import { StepChoice, StepConfirm, StepForm, StepList } from '../src/plan/screens.js'

function makeSession(overrides: Partial<PlanningSessionView> = {}): PlanningSessionView {
  return {
    session_id: 'plan-AAAA1111',
    status: 'awaiting_user',
    current_step: 'identity',
    answers: {},
    outputs: {
      identity: {
        screen_payload: {
          fields: [
            { id: 'name', label: 'Nome do projeto' },
            { id: 'description', label: 'Descreva o projeto' },
            { id: 'target_repo', label: 'Repo (opcional)' },
          ],
        },
      },
    },
    kad: {},
    project_name: null,
    target_repo: null,
    usage: { input_tokens: 0, output_tokens: 0, usd: 0, turns: 0 },
    last_error: null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
    ...overrides,
  }
}

function makeClient(session: PlanningSessionView, extra: Partial<KanbanClient> = {}): KanbanClient {
  return {
    planningGet: vi.fn().mockResolvedValue({ ok: true, data: session }),
    planningAnswer: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    planningRefine: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    planningRetry: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    planningCancel: vi.fn().mockResolvedValue({ ok: true, data: { session_id: session.session_id, status: 'cancelled' } }),
    planningFinalize: vi.fn(),
    ...extra,
  } as unknown as KanbanClient
}

function renderWizard(client: KanbanClient, sessionId = 'plan-AAAA1111') {
  return render(
    <MemoryRouter initialEntries={[`/planejar/${sessionId}`]}>
      <Routes>
        <Route path="/planejar/:sessionId" element={<PlanWizard client={client} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('PlanWizard', () => {
  it('renderiza o progresso (fase atual + contagem) e a tela form da identidade', async () => {
    const client = makeClient(makeSession())
    renderWizard(client)
    await waitFor(() => expect(screen.getByText('Nome do projeto')).toBeTruthy())
    // O stepper mostra as 4 fases; a contagem exata fica no wizard-count.
    const current = document.querySelector('.wizard-steps li.current')
    expect(current?.textContent).toBe('Contexto')
    expect(document.querySelector('.wizard-count')?.textContent).toBe('etapa 1 de 15 — Identidade')
    expect(document.querySelector('.wizard-bar > span')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Continuar' })).toBeTruthy()
  })

  it('fases anteriores ganham check, nunca line-through', async () => {
    const session = makeSession({
      current_step: 'modules',
      outputs: {
        modules: { screen_payload: { items: [{ id: 'm1', title: 'Módulo um' }] } },
      },
    })
    const client = makeClient(session)
    renderWizard(client)
    await waitFor(() => expect(screen.getByText(/etapa 8 de 15/)).toBeTruthy())
    const done = [...document.querySelectorAll('.wizard-steps li.done')].map((el) => el.textContent)
    expect(done).toEqual(['Contexto', 'Descoberta'])
    expect(document.querySelector('.wizard-steps li.current')?.textContent).toBe('Arquitetura')
  })

  it('status generating mostra o indicador de máquina', async () => {
    const client = makeClient(makeSession({ status: 'generating', current_step: 'scope' }))
    renderWizard(client)
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('arquiteto'))
  })

  it('status error oferece tentar de novo → planningRetry', async () => {
    const client = makeClient(makeSession({ status: 'error', last_error: 'rate_limit', current_step: 'scope' }))
    renderWizard(client)
    await waitFor(() => expect(screen.getByText(/limite de uso/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'tentar de novo' }))
    await waitFor(() => expect(client.planningRetry).toHaveBeenCalledWith('plan-AAAA1111'))
  })

  it('review aprovada mostra o botão Materializar e chama planningFinalize', async () => {
    const session = makeSession({
      current_step: 'review',
      answers: { review: { approved: true } },
      project_name: 'meu-app',
    })
    const finalize = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        session_id: session.session_id,
        project: 'meu-app',
        token: 'tok-secreto',
        token_id: 'tid',
        epics: 2,
        sprints: 3,
        cards_created: 8,
        cards_failed: [],
        goals: 1,
        kad_files: ['kad/vision.md'],
        repo_copy_ok: null,
      },
    })
    const client = makeClient(session, { planningFinalize: finalize } as Partial<KanbanClient>)
    renderWizard(client)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Materializar projeto' })).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Materializar projeto' }))
    // O token cru nunca chega à tela; sem repo, a orientação é setar o repositório.
    await waitFor(() => expect(screen.getByText(/repositório de trabalho/)).toBeTruthy())
    expect(screen.queryByText('tok-secreto')).toBeNull()
    expect(screen.getByText('abrir o board →').getAttribute('href')).toBe('/board/meu-app')
  })
})

describe('telas por tipo', () => {
  it('StepForm submete {campo: valor} com pré-preenchimento editável', () => {
    const onSubmit = vi.fn()
    render(
      <StepForm
        payload={{ fields: [{ id: 'positive_scope', label: 'Escopos positivos', value: 'a' }] }}
        busy={false}
        onSubmit={onSubmit}
      />,
    )
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: 'faz X e Y' } })
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({ positive_scope: 'faz X e Y' })
  })

  it('StepChoice pré-seleciona a sugestão e submete {choice}', () => {
    const onSubmit = vi.fn()
    render(
      <StepChoice
        payload={{
          question: 'Tipo?',
          options: [
            { id: 'pessoal', label: 'PESSOAL' },
            { id: 'trabalho', label: 'TRABALHO' },
          ],
          suggested: 'trabalho',
        }}
        busy={false}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({ choice: 'trabalho' })
  })

  it('StepList permite remover e adicionar itens antes de submeter', () => {
    const onSubmit = vi.fn()
    render(
      <StepList
        payload={{
          items: [
            { id: 'p1', title: 'Persona A', detail: 'a' },
            { id: 'p2', title: 'Persona B' },
          ],
        }}
        busy={false}
        onSubmit={onSubmit}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'remover Persona B' }))
    fireEvent.click(screen.getByRole('button', { name: 'Continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({ items: [{ id: 'p1', title: 'Persona A', detail: 'a' }] })
  })

  it('StepConfirm renderiza markdown, confirma e envia correção', () => {
    const onSubmit = vi.fn()
    const onRefine = vi.fn()
    render(
      <StepConfirm
        payload={{ markdown: '## Milestones\n- M1' }}
        busy={false}
        onSubmit={onSubmit}
        onRefine={onRefine}
      />,
    )
    expect(screen.getByText('Milestones')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('pedir correção'), { target: { value: 'M1 está vago' } })
    fireEvent.click(screen.getByRole('button', { name: 'corrigir' }))
    expect(onRefine).toHaveBeenCalledWith('M1 está vago')
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar e continuar' }))
    expect(onSubmit).toHaveBeenCalledWith({ approved: true })
  })
})

describe('Shell', () => {
  it('sessão de planejamento ativa vira pill na topbar, em qualquer rota', async () => {
    const session = makeSession({ project_name: 'meu-app' })
    const client = {
      planningList: vi.fn().mockResolvedValue({ ok: true, data: { sessions: [session] } }),
    } as unknown as KanbanClient
    render(
      <MemoryRouter initialEntries={['/inbox']}>
        <Shell client={client} onLogout={() => {}}>
          <p>conteúdo</p>
        </Shell>
      </MemoryRouter>,
    )
    const pill = await screen.findByText(/planejando: meu-app/)
    expect(pill.closest('a')?.getAttribute('href')).toBe('/planejar')
  })

  it('sem sessão ativa, a topbar não mostra a pill', async () => {
    const client = {
      planningList: vi.fn().mockResolvedValue({ ok: true, data: { sessions: [] } }),
    } as unknown as KanbanClient
    render(
      <MemoryRouter>
        <Shell client={client} onLogout={() => {}}>
          <p>conteúdo</p>
        </Shell>
      </MemoryRouter>,
    )
    await waitFor(() => expect(client.planningList).toHaveBeenCalled())
    expect(screen.queryByText(/planejando:/)).toBeNull()
  })
})
