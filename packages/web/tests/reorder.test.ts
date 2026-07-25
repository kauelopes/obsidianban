import { describe, expect, it } from 'vitest'
import type { CardSummary } from '@obsidiankan/types'
import { afterCardIdFor } from '../src/board/Board.js'

/**
 * kanban_reorder_card recebe `after_card_id`, não um índice. A conversão de
 * "soltei sobre este card" para "fica depois deste outro" é assimétrica em
 * relação à direção do arraste, e é o tipo de erro que passa silencioso: o card
 * simplesmente aterra uma posição adiante do lugar onde foi solto.
 */
const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }) as CardSummary)

describe('afterCardIdFor', () => {
  it('arrastando para baixo, o card fica DEPOIS do alvo', () => {
    // a sobre c  →  b, c, a, d  →  antecessor de a é c
    expect(afterCardIdFor(list, 'a', 'c')).toBe('c')
    // a sobre d (último) → fica no fim, depois de d
    expect(afterCardIdFor(list, 'a', 'd')).toBe('d')
  })

  it('arrastando para cima, o card fica ANTES do alvo', () => {
    // d sobre b  →  a, d, b, c  →  antecessor de d é a
    expect(afterCardIdFor(list, 'd', 'b')).toBe('a')
    // c sobre b → a, c, b, d → antecessor é a
    expect(afterCardIdFor(list, 'c', 'b')).toBe('a')
  })

  it('soltar sobre o primeiro card manda para o topo, com after null', () => {
    expect(afterCardIdFor(list, 'c', 'a')).toBeNull()
    expect(afterCardIdFor(list, 'd', 'a')).toBeNull()
  })

  it('movimento sem efeito devolve undefined em vez de mandar requisição', () => {
    expect(afterCardIdFor(list, 'a', 'a')).toBeUndefined()
    expect(afterCardIdFor(list, 'a', 'inexistente')).toBeUndefined()
    expect(afterCardIdFor(list, 'inexistente', 'a')).toBeUndefined()
    expect(afterCardIdFor([], 'a', 'b')).toBeUndefined()
  })

  it('vizinhos adjacentes trocam de lugar nas duas direções', () => {
    // a sobre b → b, a  → after = b
    expect(afterCardIdFor(list, 'a', 'b')).toBe('b')
    // b sobre a → b, a  → after = null (b vai para o topo)
    expect(afterCardIdFor(list, 'b', 'a')).toBeNull()
  })
})
