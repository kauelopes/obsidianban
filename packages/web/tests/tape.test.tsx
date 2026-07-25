import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { CardSummary } from '@obsidiankan/types'
import { Board } from '../src/board/Board.js'
import { groupBoard } from '../src/board/group.js'
import getSprintJson from './fixtures/get_sprint.json'

const REAL_CARDS = getSprintJson.cards as unknown as CardSummary[]
function noop() {}

function renderBoard(cards: readonly CardSummary[], escalated: ReadonlySet<string>) {
  return render(
    <MemoryRouter>
      <Board
        groups={groupBoard(cards, [{ project: 'teste', columns: ['todo', 'done'] }])}
        onMove={noop}
        onReorder={noop}
        escalated={escalated}

        showArchived={false}

        onShowArchived={noop}
        moveHint={() => null}
        onCreateCard={noop}
        onOpenSprints={noop}
        onOpenProject={noop}
        sprintFilter={{}}
        onSprintFilter={noop}
        sprintsFor={() => []}
      />
    </MemoryRouter>,
  )
}

/**
 * A marca de escalação no board vem da MESMA fonte que alimenta a inbox
 * (kanban_list_escalations), então board e inbox não podem discordar. Estes
 * testes travam essa relação e o fato de a marca nunca ser dita só por cor.
 */
describe('marca de escalação no board', () => {
  it('marca apenas os cards que a inbox listou', () => {
    const a = REAL_CARDS[0]!
    const b = REAL_CARDS[1]!
    const { container } = renderBoard([a, b], new Set([a.id]))

    expect(container.querySelectorAll('.card.escalated')).toHaveLength(1)
    // Glifo + palavra, não só cor: legível sem percepção de cor.
    expect(screen.getByText(/escalado/)).toBeTruthy()
  })

  it('sem escalação nenhuma, nenhum card ganha a marca', () => {
    const { container } = renderBoard(REAL_CARDS.slice(0, 3), new Set())
    expect(container.querySelectorAll('.card.escalated')).toHaveLength(0)
    expect(screen.queryByText(/escalado/)).toBeNull()
  })

  it('a marca não depende da coluna: um card em done também pode estar escalado', () => {
    // A escalação é derivada do log, não do status. Um card movido para done com
    // uma escalação pendente continua pedindo decisão.
    const done = REAL_CARDS.find((c) => c.status === 'done')
    if (!done) return
    const { container } = renderBoard([done], new Set([done.id]))
    expect(container.querySelectorAll('.card.escalated')).toHaveLength(1)
  })
})
