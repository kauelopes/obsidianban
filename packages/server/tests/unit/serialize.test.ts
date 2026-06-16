import { describe, it, expect } from 'vitest'
import {
  parseCardFile,
  serializeCard,
  cardFromFrontmatter,
} from '../../src/cards/serialize.js'

const VALID_FRONTMATTER: Record<string, unknown> = {
  id: 'card-abc12345',
  project: 'my-project',
  title: 'My Card',
  status: 'todo',
  type: 'task',
  version: 1,
  position: 1000,
  priority: 'medium',
  tags: ['feat', 'backend'],
  due_date: null,
  assigned_to: null,
  owner: null,
  agent_notes: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  archived: false,
  sprint_id: 'sprint-abc12345',
  blocked_by: [],
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  created_by: 'agent:pm',
  updated_by: 'agent:pm',
}

describe('parseCardFile', () => {
  it('splits YAML frontmatter from body', () => {
    const content = '---\ntitle: Hello\n---\n\nBody here.'
    const { data, body } = parseCardFile(content)
    expect(data['title']).toBe('Hello')
    expect(body.trim()).toBe('Body here.')
  })

  it('returns empty body for frontmatter-only files', () => {
    const content = '---\ntitle: Hello\n---\n'
    const { body } = parseCardFile(content)
    expect(body.trim()).toBe('')
  })
})

describe('cardFromFrontmatter', () => {
  it('parses a complete valid frontmatter into a Card', () => {
    const card = cardFromFrontmatter(VALID_FRONTMATTER)
    expect(card.id).toBe('card-abc12345')
    expect(card.title).toBe('My Card')
    expect(card.priority).toBe('medium')
  })

  it('defaults archived to false when absent', () => {
    const data = { ...VALID_FRONTMATTER }
    delete data['archived']
    const card = cardFromFrontmatter(data)
    expect(card.archived).toBe(false)
  })

  it('defaults tags to [] when absent', () => {
    const data = { ...VALID_FRONTMATTER }
    delete data['tags']
    const card = cardFromFrontmatter(data)
    expect(card.tags).toEqual([])
  })

  it('defaults blocked_by to [] when absent', () => {
    const data = { ...VALID_FRONTMATTER }
    delete data['blocked_by']
    const card = cardFromFrontmatter(data)
    expect(card.blocked_by).toEqual([])
  })

  it('defaults total_input_tokens to 0 when absent', () => {
    const data = { ...VALID_FRONTMATTER }
    delete data['total_input_tokens']
    const card = cardFromFrontmatter(data)
    expect(card.total_input_tokens).toBe(0)
  })

  it('parses archived: true as boolean true', () => {
    const card = cardFromFrontmatter({ ...VALID_FRONTMATTER, archived: true })
    expect(card.archived).toBe(true)
  })

  it('throws if priority is invalid', () => {
    expect(() => cardFromFrontmatter({ ...VALID_FRONTMATTER, priority: 'extreme' })).toThrow()
  })

  it('throws if required string field is missing', () => {
    const data = { ...VALID_FRONTMATTER }
    delete data['id']
    expect(() => cardFromFrontmatter(data)).toThrow()
  })

  it('throws if version is not a number', () => {
    expect(() => cardFromFrontmatter({ ...VALID_FRONTMATTER, version: 'one' })).toThrow()
  })
})

describe('serializeCard', () => {
  it('produces YAML frontmatter with a body', () => {
    const card = cardFromFrontmatter(VALID_FRONTMATTER)
    const output = serializeCard(card, 'Body content.')
    expect(output).toContain('---')
    expect(output).toContain('id: card-abc12345')
    expect(output).toContain('Body content.')
  })

  it('places id before title in the output (canonical order)', () => {
    const card = cardFromFrontmatter(VALID_FRONTMATTER)
    const output = serializeCard(card, '')
    const idPos = output.indexOf('id:')
    const titlePos = output.indexOf('title:')
    expect(idPos).toBeLessThan(titlePos)
  })

  it('round-trips through parse → serialize → parse', () => {
    const card = cardFromFrontmatter(VALID_FRONTMATTER)
    const serialized = serializeCard(card, 'Some body text.')
    const { data, body } = parseCardFile(serialized)
    const parsed = cardFromFrontmatter(data)
    expect(parsed.id).toBe(card.id)
    expect(parsed.title).toBe(card.title)
    expect(parsed.priority).toBe(card.priority)
    expect(parsed.tags).toEqual(card.tags)
    expect(body.trim()).toBe('Some body text.')
  })
})
