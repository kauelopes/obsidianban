import type { CardSummary } from '@obsidiankan/types'

/** Replace card by id with the server-authoritative copy. */
export function replaceCard(
  cards: readonly CardSummary[],
  updated: CardSummary,
): CardSummary[] {
  return cards.map((c) => (c.id === updated.id ? updated : c))
}

/** Apply a shallow patch to the card with the given id. */
export function patchCard(
  cards: readonly CardSummary[],
  id: string,
  patch: Partial<CardSummary>,
): CardSummary[] {
  return cards.map((c) => (c.id === id ? { ...c, ...patch } : c))
}

export function appendCard(cards: readonly CardSummary[], card: CardSummary): CardSummary[] {
  return [...cards, card]
}

export function removeCard(cards: readonly CardSummary[], id: string): CardSummary[] {
  return cards.filter((c) => c.id !== id)
}
