import { describe, it, expect } from 'vitest'
import type { Card } from '@obsidiankan/types'
import { changedFields, draftFromCard } from '../src/card/FrontmatterForm.js'

function card(over: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    project: 'p1',
    title: 'Titulo',
    status: 'todo',
    type: 'task',
    version: 3,
    position: 1000,
    priority: 'medium',
    tags: ['a'],
    due_date: null,
    assigned_to: null,
    owner: null,
    agent_notes: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'human:me',
    updated_by: 'human:me',
    archived: false,
    sprint_id: 's1',
    blocked_by: ['card-9'],
    body: '',
    ...over,
  }
}

describe('changedFields', () => {
  it('sends nothing when the draft is untouched', () => {
    const c = card()
    expect(changedFields(c, draftFromCard(c))).toEqual({})
  })

  it('sends only the field that changed', () => {
    const c = card()
    const d = { ...draftFromCard(c), title: 'Novo' }
    expect(changedFields(c, d)).toEqual({ title: 'Novo' })
  })

  it('detects a cleared due date', () => {
    const c = card({ due_date: '2026-08-01' })
    const d = { ...draftFromCard(c), due_date: null }
    expect(changedFields(c, d)).toEqual({ due_date: null })
  })

  it('detects a cleared assignee as null, not empty string', () => {
    const c = card({ assigned_to: 'agent:dev' })
    const d = { ...draftFromCard(c), assigned_to: null }
    expect(changedFields(c, d)).toEqual({ assigned_to: null })
  })

  it('ignores tag reordering only when the content is identical', () => {
    const c = card({ tags: ['a', 'b'] })
    expect(changedFields(c, { ...draftFromCard(c), tags: ['a', 'b'] })).toEqual({})
    expect(changedFields(c, { ...draftFromCard(c), tags: ['b', 'a'] })).toHaveProperty('tags')
  })

  it('treats blocked_by as a set — reordering is not a change', () => {
    const c = card({ blocked_by: ['card-9', 'card-8'] })
    const d = { ...draftFromCard(c), blocked_by: ['card-8', 'card-9'] }
    expect(changedFields(c, d)).toEqual({})
  })

  it('detects a real blocked_by change', () => {
    const c = card()
    const d = { ...draftFromCard(c), blocked_by: ['card-9', 'card-7'] }
    expect(changedFields(c, d)['blocked_by']).toEqual(['card-9', 'card-7'])
  })

  it('never sends an empty sprint_id — the server requires a real one', () => {
    const c = card()
    const d = { ...draftFromCard(c), sprint_id: undefined }
    expect(changedFields(c, d)).not.toHaveProperty('sprint_id')
  })

  it('sends a genuine sprint change', () => {
    const c = card()
    const d = { ...draftFromCard(c), sprint_id: 's2' }
    expect(changedFields(c, d)).toEqual({ sprint_id: 's2' })
  })
})
