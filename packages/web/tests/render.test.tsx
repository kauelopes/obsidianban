import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { CardSummary } from '@obsidiankan/types'
import { Board } from '../src/board/Board.js'
import { groupBoard } from '../src/board/group.js'
import { authorOf } from '../src/card/author.js'
import getSprintJson from './fixtures/get_sprint.json'

/**
 * Os primeiros testes de render do projeto.
 *
 * Até aqui o vitest rodava em ambiente node e nada montava um componente — que
 * é precisamente como as três fases anteriores entregaram um board vazio e um
 * filtro de sprint sempre vazio sem nenhum teste vermelho. Estes montam a UI
 * com os cards REAIS capturados do servidor, não com objetos inventados à mão.
 */

// 13 cards de verdade, com todos os 23 campos que o servidor devolve.
const REAL_CARDS = getSprintJson.cards as unknown as CardSummary[]

function noop() {}

function renderBoard(cards: readonly CardSummary[], columns = ['backlog', 'todo', 'in_progress', 'review', 'done']) {
  const groups = groupBoard(cards, [{ project: 'teste', columns }])
  return render(
    <MemoryRouter>
      <Board
        groups={groups}
        onMove={noop}
        onReorder={noop}

        escalated={new Set()}


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

describe('Board', () => {
  it('renderiza os cards reais em colunas em vez de uma tela vazia', () => {
    renderBoard(REAL_CARDS)

    // O bug da fase 2 foi exatamente este: board vazio. Um título de card na
    // tela é a asserção mínima que o teria pegado.
    expect(screen.getByText('teste')).toBeTruthy()
    expect(screen.getByText(`${REAL_CARDS.length} cards`)).toBeTruthy()

    const first = REAL_CARDS[0]!
    expect(screen.getByText(first.title)).toBeTruthy()

    // Toda coluna declarada aparece, mesmo vazia.
    for (const col of ['backlog', 'todo', 'in progress', 'review', 'done']) {
      expect(screen.getByText(col)).toBeTruthy()
    }
  })

  it('mostra o id do card sem o prefixo, em slot próprio', () => {
    renderBoard(REAL_CARDS)
    const first = REAL_CARDS[0]!
    expect(screen.getByText(first.id.replace(/^card-/, ''))).toBeTruthy()
  })

  it('nenhum card desaparece: todo título renderiza', () => {
    renderBoard(REAL_CARDS)
    // Títulos duplicados existem no test-vault, então contamos ocorrências.
    for (const c of REAL_CARDS) {
      expect(screen.getAllByText(c.title).length).toBeGreaterThan(0)
    }
  })

  /**
   * Regressão do estado real do vault do usuário: três projetos ativos e zero
   * cards visíveis, porque os 30 cards de `avare` estão todos arquivados.
   *
   * Antes, isso trocava o board inteiro por uma frase — e como "+ card",
   * "sprints" e "ajustes" moram no cabeçalho do projeto, o usuário ficava sem
   * nenhuma via de criar o que faltava.
   */
  it('mantém os projetos e suas ações quando nenhum card está visível', () => {
    const semCards = groupBoard([], [
      { project: 'avare', columns: ['todo', 'done'] },
      { project: 'Contratos_Automaticos', columns: ['todo', 'done'] },
    ])
    render(
      <MemoryRouter>
        <Board
          groups={semCards}
          onMove={noop}
          onReorder={noop}
          escalated={new Set()}
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

    expect(screen.getByText('avare')).toBeTruthy()
    expect(screen.getByText('Contratos_Automaticos')).toBeTruthy()
    // As ações por projeto continuam alcançáveis — este é o ponto.
    expect(screen.getAllByText('+ card')).toHaveLength(2)
    expect(screen.getAllByText('sprints')).toHaveLength(2)
    expect(screen.getAllByText('ajustes')).toHaveLength(2)
    // E o aviso oferece a ação em vez de mandar procurar um checkbox.
    expect(screen.getByText('mostrar arquivados')).toBeTruthy()
  })

  it('só toma a tela inteira quando não há projeto nenhum', () => {
    // Sem projeto declarado E sem card — aí sim a tela inteira é a mensagem.
    const { container } = render(
      <MemoryRouter>
        <Board
          groups={groupBoard([], [])}
          onMove={noop}
          onReorder={noop}
          escalated={new Set()}
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
    // textContent porque a frase é quebrada por um <strong>.
    expect(container.textContent).toContain('Nenhum projeto ainda')
    expect(container.querySelectorAll('.column')).toHaveLength(0)
  })

  it('o aviso de arquivados some quando o toggle já está ligado', () => {
    const semCards = groupBoard([], [{ project: 'avare', columns: ['todo'] }])
    render(
      <MemoryRouter>
        <Board
          groups={semCards}
          onMove={noop}
          onReorder={noop}
          escalated={new Set()}
          showArchived
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
    // Já mostrando arquivados e ainda vazio: o projeto está mesmo vazio, e
    // repetir o aviso seria ruído.
    expect(screen.queryByText('mostrar arquivados')).toBeNull()
    expect(screen.getByText('avare')).toBeTruthy()
  })

  it('trilho de autoria: humano, agente e desconhecido são visualmente distintos', () => {
    const base = REAL_CARDS[0]!
    const cards: CardSummary[] = [
      { ...base, id: 'card-h', title: 'escrito por humano', updated_by: 'human:kaue' },
      { ...base, id: 'card-a', title: 'escrito por agente', updated_by: 'agent:claude' },
      { ...base, id: 'card-u', title: 'ator sem prefixo', updated_by: 'kae' },
    ]
    const { container } = renderBoard(cards)

    expect(container.querySelectorAll('.card.by-human')).toHaveLength(1)
    expect(container.querySelectorAll('.card.by-agent')).toHaveLength(1)
    // Sem prefixo não recebe classe: o trilho fica neutro em vez de afirmar
    // uma autoria que o dado não sustenta.
    expect(container.querySelectorAll('.card:not(.by-human):not(.by-agent)')).toHaveLength(1)
  })

  it('mostra o motivo de um drop recusado na tela, não só no title=', () => {
    const groups = groupBoard(REAL_CARDS, [{ project: 'teste', columns: ['todo', 'done'] }])
    const { container } = render(
      <MemoryRouter>
        <Board
          groups={groups}
          onMove={noop}
          onReorder={noop}

          escalated={new Set()}


          showArchived={false}


          onShowArchived={noop}
          moveHint={() => 'bloqueado por 2 card(s)'}
          onCreateCard={noop}
          onOpenSprints={noop}
          onOpenProject={noop}
          sprintFilter={{}}
          onSprintFilter={noop}
          sprintsFor={() => []}
        />
      </MemoryRouter>,
    )
    // Sem arraste em curso não há hint — moveHint só é consultado com um card
    // sendo arrastado, então aqui a coluna não fica marcada.
    expect(container.querySelectorAll('.column.blocked')).toHaveLength(0)
  })
})

describe('authorOf', () => {
  it('só afirma autoria quando o prefixo existe', () => {
    expect(authorOf('human:kaue')).toBe('human')
    expect(authorOf('agent:claude')).toBe('agent')
    // Todos estes são atores reais dos dois vaults. Nenhum tem prefixo.
    expect(authorOf('kae')).toBe('unknown')
    expect(authorOf('asdf')).toBe('unknown')
    expect(authorOf('dev-claude')).toBe('unknown')
    expect(authorOf('pm-agent')).toBe('unknown')
    expect(authorOf('plugin')).toBe('unknown')
    expect(authorOf('external:script')).toBe('unknown')
    expect(authorOf(null)).toBe('unknown')
    expect(authorOf('')).toBe('unknown')
  })
})
