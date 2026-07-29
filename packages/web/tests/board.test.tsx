import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { CardSummary } from '@obsidiankan/types'
import { Board } from '../src/board/Board.js'
import { groupBoard } from '../src/board/group.js'

function card(overrides: Partial<CardSummary>): CardSummary {
  return {
    id: 'card-0001',
    project: 'teste',
    title: 'Card',
    status: 'todo',
    type: 'task',
    version: 1,
    position: 1000,
    priority: 'medium',
    tags: [],
    due_date: null,
    assigned_to: null,
    owner: null,
    agent_notes: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    created_by: 'kae',
    updated_by: 'kae',
    file_basename: 'Card',
    archived: false,
    sprint_id: null,
    blocked_by: [],
    ...overrides,
  } as CardSummary
}

function renderBoard(cards: CardSummary[], escalated: ReadonlySet<string> = new Set()) {
  const groups = groupBoard(cards, [
    { project: 'teste', columns: ['backlog', 'todo', 'in_progress', 'review', 'done'] },
  ])
  return render(
    <MemoryRouter>
      <Board
        groups={groups}
        onMove={() => {}}
        onReorder={() => {}}
        moveHint={() => null}
        escalated={escalated}
        showArchived={false}
        onShowArchived={() => {}}
        onCreateCard={() => {}}
        onOpenSprints={() => {}}
        onOpenProject={() => {}}
        sprintFilter={{}}
        onSprintFilter={() => {}}
        sprintsFor={() => []}
      />
    </MemoryRouter>,
  )
}

describe('Board — densidade de metadados do card', () => {
  it('sem sinal de alerta, id/responsável e tags ficam em peso normal', () => {
    const { container } = renderBoard([
      card({ id: 'card-a', assigned_to: 'kae', tags: ['a', 'b'] }),
    ])
    expect(container.querySelector('.card-meta-admin.dim')).toBeNull()
    expect(container.querySelector('.card-tags.dim')).toBeNull()
  })

  it('bloqueado rebaixa id/responsável e tags para peso administrativo', () => {
    const { container } = renderBoard([
      card({ id: 'card-b', assigned_to: 'kae', tags: ['a', 'b'], blocked_by: ['card-x'] }),
    ])
    expect(container.querySelector('.card-meta-admin.dim')).toBeTruthy()
    expect(container.querySelector('.card-tags.dim')).toBeTruthy()
  })

  it('escalado também rebaixa os metadados administrativos', () => {
    const { container } = renderBoard(
      [card({ id: 'card-c', assigned_to: 'kae' })],
      new Set(['card-c']),
    )
    expect(container.querySelector('.card-meta-admin.dim')).toBeTruthy()
  })

  it('mais de 3 tags mostram indicador +N e escondem o resto', () => {
    const { container } = renderBoard([
      card({ id: 'card-d', tags: ['um', 'dois', 'tres', 'quatro', 'cinco'] }),
    ])
    const tags = container.querySelectorAll('.card-tags .tag:not(.tag-more)')
    expect(tags.length).toBe(3)
    expect(container.querySelector('.tag-more')?.textContent).toBe('+2')
  })

  it('cards ficam focáveis por teclado (dnd-kit registra os atributos do KeyboardSensor)', () => {
    const { container } = renderBoard([card({ id: 'card-e' })])
    const el = container.querySelector('.card')
    expect(el?.getAttribute('tabindex')).toBe('0')
  })
})
