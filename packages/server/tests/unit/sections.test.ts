import { describe, it, expect } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseSections,
  serializeSections,
  replaceZone,
} from '@obsidiankan/types'
import { parseCardFile } from '../../src/cards/serialize.js'

describe('parseSections — legacy cards', () => {
  it('treats a body with no recognized heading as Spec', () => {
    const body = 'Contexto solto, sem headings.\n\n- criterio A\n- criterio B'
    expect(parseSections(body)).toEqual({
      spec: body,
      notes: '',
      agentLog: '',
    })
  })

  it('keeps a preamble above the headings in Spec', () => {
    const body = 'Texto antes.\n\n# Notes\n\nmemoria'
    const s = parseSections(body)
    expect(s.spec).toBe('Texto antes.')
    expect(s.notes).toBe('memoria')
  })

  it('splits a card that only has # Agent Log', () => {
    const body = 'A descricao original.\n\n# Agent Log\n\n**2026-06-01T00:53:07Z**\n\nfeito'
    const s = parseSections(body)
    expect(s.spec).toBe('A descricao original.')
    expect(s.notes).toBe('')
    expect(s.agentLog).toBe('**2026-06-01T00:53:07Z**\n\nfeito')
  })

  it('parses all three zones', () => {
    const body = [
      '# Spec',
      '',
      'o que fazer',
      '',
      '# Notes',
      '',
      'working memory',
      '',
      '# Agent Log',
      '',
      '**ts**',
      '',
      'entrada',
    ].join('\n')
    expect(parseSections(body)).toEqual({
      spec: 'o que fazer',
      notes: 'working memory',
      agentLog: '**ts**\n\nentrada',
    })
  })

  it('returns three empty zones for an empty body', () => {
    expect(parseSections('')).toEqual({ spec: '', notes: '', agentLog: '' })
  })
})

describe('parseSections — headings inside fenced code', () => {
  it('does not split on a heading inside a ``` block', () => {
    const body = [
      '# Spec',
      '',
      'exemplo:',
      '',
      '```markdown',
      '# Notes',
      'isso e conteudo, nao um heading',
      '```',
      '',
      '# Agent Log',
      '',
      '**ts**',
    ].join('\n')
    const s = parseSections(body)
    expect(s.notes).toBe('')
    expect(s.spec).toContain('# Notes')
    expect(s.spec).toContain('isso e conteudo')
    expect(s.agentLog).toBe('**ts**')
  })

  it('does not split on a heading inside a mermaid block', () => {
    const body = ['# Spec', '', '```mermaid', 'graph TD', '  A --> B', '```', '', '# Notes', '', 'n'].join('\n')
    const s = parseSections(body)
    expect(s.spec).toContain('mermaid')
    expect(s.notes).toBe('n')
  })

  it('handles ~~~ fences', () => {
    const body = ['# Spec', '', '~~~', '# Notes', '~~~'].join('\n')
    expect(parseSections(body).notes).toBe('')
  })
})

describe('serializeSections', () => {
  it('omits empty zones', () => {
    expect(serializeSections({ spec: 'a', notes: '', agentLog: '' })).toBe('# Spec\n\na')
  })

  it('emits zones in canonical order regardless of input order', () => {
    const out = serializeSections({ spec: 's', notes: 'n', agentLog: 'l' })
    expect(out.indexOf('# Spec')).toBeLessThan(out.indexOf('# Notes'))
    expect(out.indexOf('# Notes')).toBeLessThan(out.indexOf('# Agent Log'))
  })

  it('returns an empty string when every zone is empty', () => {
    expect(serializeSections({ spec: '', notes: '', agentLog: '' })).toBe('')
  })
})

describe('round-trip idempotence', () => {
  const bodies = [
    'legado sem headings',
    '# Spec\n\na\n\n# Notes\n\nb\n\n# Agent Log\n\nc',
    'preambulo\n\n# Agent Log\n\n**ts**\n\nx',
    '',
    '# Spec\n\n```\n# Notes\n```',
  ]

  it('is a fixed point: f(f(x)) === f(x)', () => {
    for (const body of bodies) {
      const once = serializeSections(parseSections(body))
      const twice = serializeSections(parseSections(once))
      expect(twice).toBe(once)
    }
  })
})

describe('replaceZone', () => {
  const body = '# Spec\n\nspec original\n\n# Agent Log\n\n**ts**\n\nlog original'

  it('replaces Spec without touching Agent Log', () => {
    const out = replaceZone(body, 'spec', 'spec novo')
    const s = parseSections(out)
    expect(s.spec).toBe('spec novo')
    expect(s.agentLog).toBe('**ts**\n\nlog original')
  })

  it('creates Notes on a card that has none', () => {
    const s = parseSections(replaceZone(body, 'notes', 'memoria'))
    expect(s.notes).toBe('memoria')
    expect(s.spec).toBe('spec original')
    expect(s.agentLog).toBe('**ts**\n\nlog original')
  })

  it('clears a zone when given an empty string', () => {
    const out = replaceZone(body, 'spec', '')
    expect(parseSections(out).spec).toBe('')
    expect(out).not.toContain('# Spec')
    expect(parseSections(out).agentLog).toBe('**ts**\n\nlog original')
  })
})

describe('round-trip over the real cards in test-vault/', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const vaultCards = path.resolve(here, '../../../../test-vault/kanban-data')
  // test-vault/ is gitignored dev-only state, so it is absent on a fresh
  // clone. Skip rather than fail there; when it exists, assert in full.
  const hasVault = existsSync(vaultCards)

  it.skipIf(!hasVault)('preserves every zone and stays idempotent on real card bodies', async () => {
    const projects = await fs.readdir(vaultCards, { withFileTypes: true })
    const files: string[] = []
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = path.join(vaultCards, p.name)
      for (const f of await fs.readdir(dir)) {
        if (f.endsWith('.md')) files.push(path.join(dir, f))
      }
    }
    // Guards against the test silently passing if the fixture vault moves.
    expect(files.length).toBeGreaterThan(0)

    for (const file of files) {
      const { body } = parseCardFile(await fs.readFile(file, 'utf8'))
      const once = serializeSections(parseSections(body))
      const twice = serializeSections(parseSections(once))
      expect(twice, `not idempotent: ${file}`).toBe(once)

      // No card content may be dropped: every non-empty line of the original
      // body has to survive somewhere in the normalized output.
      for (const line of body.split(/\r?\n/)) {
        const t = line.trim()
        if (!t || /^#\s+(Spec|Notes|Agent Log)$/i.test(t)) continue
        expect(once, `line lost from ${file}: ${t}`).toContain(t)
      }
    }
  })
})
