import { describe, expect, it } from 'vitest'
import {
  formatLogHeading,
  isLogKind,
  lastExplicitLogKind,
  parseLogEntries,
} from '@obsidiankan/types'

/**
 * O kind de uma entrada do log vive no cabeçalho da própria entrada, e o estado
 * de escalação do card é derivado dele na leitura. Isso mantém o SQLite como
 * índice descartável e faz uma escalação escrita à mão no Obsidian valer igual.
 */

describe('formatLogHeading', () => {
  it('omite o marcador no caso comum para não poluir o log', () => {
    expect(formatLogHeading('2026-06-01T00:00:00Z')).toBe('**2026-06-01T00:00:00Z**')
    expect(formatLogHeading('2026-06-01T00:00:00Z', 'progress')).toBe('**2026-06-01T00:00:00Z**')
  })

  it('escreve o marcador para os kinds que mudam o que o humano vê', () => {
    expect(formatLogHeading('2026-06-01T00:00:00Z', 'escalate')).toBe(
      '**2026-06-01T00:00:00Z** `escalate`',
    )
    expect(formatLogHeading('2026-06-01T00:00:00Z', 'pm_resolved')).toBe(
      '**2026-06-01T00:00:00Z** `pm_resolved`',
    )
  })

  it('faz round-trip com o parser', () => {
    const body = `${formatLogHeading('2026-06-01T00:00:00Z', 'escalate')}\n\nbloqueado`
    const [e] = parseLogEntries(body)
    expect(e!.kind).toBe('escalate')
    expect(e!.explicit).toBe(true)
    expect(e!.text).toBe('bloqueado')
  })
})

describe('parseLogEntries', () => {
  it('card legado sem marcador nenhum vira progress implícito', () => {
    const log = '**2026-06-01T00:53:07Z**\n\nfiz o trabalho'
    const [e] = parseLogEntries(log)
    expect(e!.kind).toBe('progress')
    // `explicit` false é o que mantém o card fora da inbox: ninguém declarou nada.
    expect(e!.explicit).toBe(false)
  })

  it('reconhece o marcador [ESCALATE] em texto, que era a convenção do PRD', () => {
    const log = '**2026-06-01T00:53:07Z**\n\n[ESCALATE] preciso de decisão'
    const [e] = parseLogEntries(log)
    expect(e!.kind).toBe('escalate')
    expect(e!.explicit).toBe(true)
    // O marcador sai do texto — ele virou metadado.
    expect(e!.text).toBe('preciso de decisão')
  })

  it('um cabeçalho dentro de bloco de código é conteúdo, não separador', () => {
    const log = [
      '**2026-06-01T00:00:00Z** `escalate`',
      '',
      'veja o exemplo:',
      '',
      '```markdown',
      '**2026-06-02T00:00:00Z** `done`',
      'isto é exemplo, não uma entrada',
      '```',
    ].join('\n')

    const entries = parseLogEntries(log)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('escalate')
    expect(entries[0]!.text).toContain('isto é exemplo')
  })

  it('mermaid no log não quebra a divisão de entradas', () => {
    const log = [
      '**2026-06-01T00:00:00Z**',
      '',
      '```mermaid',
      'graph TD',
      '  A[Agente] --> B[Claim]',
      '```',
      '',
      '**2026-06-02T00:00:00Z** `done`',
      '',
      'pronto',
    ].join('\n')

    const entries = parseLogEntries(log)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.text).toContain('graph TD')
    expect(entries[1]!.kind).toBe('done')
  })

  it('preâmbulo antes do primeiro timestamp não é descartado', () => {
    const entries = parseLogEntries('nota solta\n\n**2026-06-01T00:00:00Z**\n\ndepois')
    expect(entries).toHaveLength(2)
    expect(entries[0]!.ts).toBeNull()
    expect(entries[0]!.text).toBe('nota solta')
  })

  it('kind desconhecido no marcador não é aceito como kind', () => {
    const [e] = parseLogEntries('**2026-06-01T00:00:00Z** `banana`\n\ntexto')
    expect(e!.kind).toBe('progress')
    expect(e!.explicit).toBe(false)
  })

  it('log vazio devolve lista vazia', () => {
    expect(parseLogEntries('')).toEqual([])
    expect(parseLogEntries('  \n ')).toEqual([])
  })
})

describe('lastExplicitLogKind', () => {
  it('a resolução do PM ganha da escalação porque é mais nova', () => {
    const log = [
      '**2026-06-01T00:00:00Z** `escalate`',
      '',
      'preciso de decisão',
      '',
      '**2026-06-02T00:00:00Z** `pm_resolved`',
      '',
      'decidido',
    ].join('\n')
    expect(lastExplicitLogKind(log)).toBe('pm_resolved')
  })

  it('progress posterior NÃO apaga uma escalação pendente', () => {
    // Um agente que loga progresso depois de escalar não resolveu nada: só
    // entradas com kind explícito contam, e progress implícito é ignorado.
    const log = [
      '**2026-06-01T00:00:00Z** `escalate`',
      '',
      'preciso de decisão',
      '',
      '**2026-06-02T00:00:00Z**',
      '',
      'continuei em outra parte',
    ].join('\n')
    expect(lastExplicitLogKind(log)).toBe('escalate')
  })

  it('sem nenhum kind explícito devolve null', () => {
    expect(lastExplicitLogKind('**2026-06-01T00:00:00Z**\n\nfiz')).toBeNull()
    expect(lastExplicitLogKind('')).toBeNull()
  })
})

describe('isLogKind', () => {
  it('aceita só os quatro do contrato', () => {
    for (const k of ['progress', 'escalate', 'done', 'pm_resolved']) {
      expect(isLogKind(k)).toBe(true)
    }
    for (const k of ['', 'ESCALATE', 'resolved', null, undefined, 1, {}]) {
      expect(isLogKind(k)).toBe(false)
    }
  })
})
