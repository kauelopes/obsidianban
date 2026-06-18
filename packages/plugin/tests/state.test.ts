import { describe, it, expect } from 'vitest'
import { replaceCard, patchCard, appendCard, removeCard } from '../src/view/state'
import type { CardSummary } from '@obsidiankan/types'

function card(id: string, extra: Partial<CardSummary> = {}): CardSummary {
  return {
    id,
    project: 'proj',
    title: `Card ${id}`,
    status: 'todo',
    type: 'task',
    version: 1,
    position: 0,
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
    created_by: 'human:test',
    updated_by: 'human:test',
    archived: false,
    sprint_id: null,
    blocked_by: [],
    ...extra,
  }
}

describe('replaceCard', () => {
  it('substitui o card com o id correspondente', () => {
    const cards = [card('a'), card('b'), card('c')]
    const updated = card('b', { status: 'done' })
    const result = replaceCard(cards, updated)
    expect(result[1]).toBe(updated)
    expect(result[0]).toBe(cards[0])
    expect(result[2]).toBe(cards[2])
  })

  it('não altera a lista se o id não existe', () => {
    const cards = [card('a'), card('b')]
    const result = replaceCard(cards, card('z'))
    expect(result).toEqual(cards)
  })

  it('não muta a lista original', () => {
    const cards = [card('a')]
    replaceCard(cards, card('a', { status: 'done' }))
    expect(cards[0]?.status).toBe('todo')
  })
})

describe('patchCard', () => {
  it('aplica patch no card com o id correspondente', () => {
    const cards = [card('a'), card('b')]
    const result = patchCard(cards, 'a', { status: 'done', version: 2 })
    expect(result[0]?.status).toBe('done')
    expect(result[0]?.version).toBe(2)
    expect(result[0]?.title).toBe('Card a')
  })

  it('não altera outros cards', () => {
    const cards = [card('a'), card('b')]
    const result = patchCard(cards, 'a', { status: 'done' })
    expect(result[1]).toBe(cards[1])
  })

  it('não altera nada se o id não existe', () => {
    const cards = [card('a')]
    const result = patchCard(cards, 'z', { status: 'done' })
    expect(result[0]?.status).toBe('todo')
  })

  it('não muta o card original', () => {
    const original = card('a')
    const cards = [original]
    patchCard(cards, 'a', { status: 'done' })
    expect(original.status).toBe('todo')
  })
})

describe('appendCard', () => {
  it('adiciona o card ao final da lista', () => {
    const cards = [card('a'), card('b')]
    const novo = card('c')
    const result = appendCard(cards, novo)
    expect(result).toHaveLength(3)
    expect(result[2]).toBe(novo)
  })

  it('não altera os cards existentes', () => {
    const cards = [card('a')]
    const result = appendCard(cards, card('b'))
    expect(result[0]).toBe(cards[0])
  })

  it('não muta a lista original', () => {
    const cards = [card('a')]
    appendCard(cards, card('b'))
    expect(cards).toHaveLength(1)
  })

  it('funciona em lista vazia', () => {
    const result = appendCard([], card('a'))
    expect(result).toHaveLength(1)
  })
})

describe('removeCard', () => {
  it('remove o card com o id correspondente', () => {
    const cards = [card('a'), card('b'), card('c')]
    const result = removeCard(cards, 'b')
    expect(result).toHaveLength(2)
    expect(result.find((c) => c.id === 'b')).toBeUndefined()
  })

  it('preserva a ordem dos demais cards', () => {
    const cards = [card('a'), card('b'), card('c')]
    const result = removeCard(cards, 'b')
    expect(result[0]?.id).toBe('a')
    expect(result[1]?.id).toBe('c')
  })

  it('não altera nada se o id não existe', () => {
    const cards = [card('a'), card('b')]
    const result = removeCard(cards, 'z')
    expect(result).toHaveLength(2)
  })

  it('não muta a lista original', () => {
    const cards = [card('a'), card('b')]
    removeCard(cards, 'a')
    expect(cards).toHaveLength(2)
  })
})
