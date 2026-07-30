import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import type { SprintPlanningSessionView } from '@obsidiankan/types'
import type { KanbanClient } from '../src/api/client.js'
import { SprintPlanWizard } from '../src/sprint-plan/SprintPlanWizard.js'

function makeSession(overrides: Partial<SprintPlanningSessionView> = {}): SprintPlanningSessionView {
  return {
    session_id: 'sprint-plan-AAAA1111',
    project: 'proj',
    status: 'awaiting_user',
    current_step: 'goal',
    context: { target_repo: null },
    answers: {},
    outputs: {
      goal: {
        screen_payload: {
          fields: [
            {
              id: 'objective',
              label: 'Objetivo da sprint',
              help: 'Descreva o que você quer entregar nesta sprint',
            },
          ],
        },
      },
    },
    usage: { input_tokens: 0, output_tokens: 0, usd: 0, turns: 0 },
    last_error: null,
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
    ...overrides,
  }
}

function makeClient(session: SprintPlanningSessionView, extra: Partial<KanbanClient> = {}): KanbanClient {
  return {
    sprintPlanningGet: vi.fn().mockResolvedValue({ ok: true, data: session }),
    sprintPlanningAnswer: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    sprintPlanningRefine: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    sprintPlanningRetry: vi.fn().mockResolvedValue({ ok: true, data: { ...session, status: 'generating' } }),
    sprintPlanningCancel: vi
      .fn()
      .mockResolvedValue({ ok: true, data: { session_id: session.session_id, status: 'cancelled' } }),
    sprintPlanningFinalize: vi.fn(),
    ...extra,
  } as unknown as KanbanClient
}

function renderWizard(client: KanbanClient, sessionId = 'sprint-plan-AAAA1111') {
  return render(
    <MemoryRouter initialEntries={[`/planejar-sprint/${sessionId}`]}>
      <Routes>
        <Route path="/planejar-sprint/:sessionId" element={<SprintPlanWizard client={client} />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('SprintPlanWizard — etapa goal', () => {
  it('renderiza a caixa de texto livre do objetivo, sem etapa de capacidade', async () => {
    const client = makeClient(makeSession())
    renderWizard(client)
    await waitFor(() => expect(screen.getByText('Objetivo da sprint')).toBeTruthy())
    expect(document.querySelector('.wizard-count')?.textContent).toBe('etapa 1 de 4 — Objetivo')
    expect(screen.queryByText('Capacidade')).toBeNull()
  })

  it('desabilita "Continuar" com o campo vazio; habilita e envia o texto ao preencher', async () => {
    const client = makeClient(makeSession())
    renderWizard(client)
    await waitFor(() => expect(screen.getByText('Objetivo da sprint')).toBeTruthy())

    const button = screen.getByRole('button', { name: 'Continuar' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)

    const textarea = document.querySelector('textarea')!
    fireEvent.change(textarea, { target: { value: 'Reduzir o tempo de onboarding' } })
    expect(button.disabled).toBe(false)

    fireEvent.click(button)
    await waitFor(() =>
      expect(client.sprintPlanningAnswer).toHaveBeenCalledWith('sprint-plan-AAAA1111', 'goal', {
        objective: 'Reduzir o tempo de onboarding',
      }),
    )
  })
})
