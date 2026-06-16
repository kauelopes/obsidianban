import { describe, it, expect } from 'vitest'
import { slugifyTitle, uniqueBasename } from '../../src/cards/slug.js'

describe('slugifyTitle', () => {
  it('lowercases the title', () => {
    expect(slugifyTitle('Hello World')).toBe('hello-world')
  })

  it('strips accents (NFKD normalization)', () => {
    expect(slugifyTitle('Café')).toBe('cafe')
    expect(slugifyTitle('naïve résumé')).toBe('naive-resume')
  })

  it('replaces runs of spaces with a single hyphen', () => {
    expect(slugifyTitle('foo  bar')).toBe('foo-bar')
  })

  it('collapses mixed symbol runs into a single hyphen', () => {
    expect(slugifyTitle('foo !! bar')).toBe('foo-bar')
  })

  it('trims leading and trailing hyphens', () => {
    expect(slugifyTitle('  Hello  ')).toBe('hello')
    expect(slugifyTitle('...Hello...')).toBe('hello')
  })

  it('falls back to "untitled" for empty input', () => {
    expect(slugifyTitle('')).toBe('untitled')
  })

  it('falls back to "untitled" for symbol-only input', () => {
    expect(slugifyTitle('???---!!!')).toBe('untitled')
  })

  it('truncates to 80 chars', () => {
    const long = 'a'.repeat(100)
    const slug = slugifyTitle(long)
    expect(slug).toHaveLength(80)
  })

  it('does not leave trailing hyphens after truncation', () => {
    // Build a 79-char slug + hyphen at position 80 (gets trimmed)
    const title = 'a'.repeat(79) + ' extra words'
    const slug = slugifyTitle(title)
    expect(slug).not.toMatch(/-$/)
  })

  it('preserves underscores', () => {
    expect(slugifyTitle('my_feature')).toBe('my_feature')
  })

  it('handles a realistic title', () => {
    expect(slugifyTitle('Fix: User auth (WIP) #123')).toBe('fix-user-auth-wip-123')
  })
})

describe('uniqueBasename', () => {
  function makeRepo(existingBasenames: Map<string, string>) {
    return {
      findByBasename: (_project: string, basename: string) => {
        const id = existingBasenames.get(basename)
        if (!id) return null
        return { id } as { id: string }
      },
    }
  }

  it('returns the base slug when no collision exists', () => {
    const repo = makeRepo(new Map())
    // @ts-expect-error minimal mock
    expect(uniqueBasename(repo, 'proj', 'my-card')).toBe('my-card')
  })

  it('appends -2 on first collision', () => {
    const existing = new Map([['my-card', 'card-other1']])
    // @ts-expect-error minimal mock
    expect(uniqueBasename(makeRepo(existing), 'proj', 'my-card')).toBe('my-card-2')
  })

  it('appends -3 when -2 also collides', () => {
    const existing = new Map([
      ['my-card', 'card-other1'],
      ['my-card-2', 'card-other2'],
    ])
    // @ts-expect-error minimal mock
    expect(uniqueBasename(makeRepo(existing), 'proj', 'my-card')).toBe('my-card-3')
  })

  it('returns base slug when collision belongs to selfId (rename no-op)', () => {
    const existing = new Map([['my-card', 'card-self123']])
    // @ts-expect-error minimal mock
    expect(uniqueBasename(makeRepo(existing), 'proj', 'my-card', 'card-self123')).toBe('my-card')
  })

  it('uses next suffix when collision is from a different card even with selfId', () => {
    const existing = new Map([['my-card', 'card-other1']])
    // @ts-expect-error minimal mock
    expect(uniqueBasename(makeRepo(existing), 'proj', 'my-card', 'card-self123')).toBe('my-card-2')
  })
})
