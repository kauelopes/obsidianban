import { describe, expect, it } from 'vitest'
import type { ReportDocument } from '../../server/api-types.js'
import { demoteHeadings, toMarkdown } from '../../server/markdown.js'
import { cleanAnalysis, buildAnalysisPrompt } from '../../server/analysis.js'

function doc(over: Partial<ReportDocument> = {}): ReportDocument {
  return {
    kicker: 'Relatório de sprint',
    title: 'Sprint S1',
    subtitle: 'alfa · encerrada',
    period: { from: '2026-07-06', to: '2026-07-10' },
    generated_at: '2026-07-20T12:00:00.000Z',
    sections: [],
    notes: [],
    ...over,
  }
}

describe('toMarkdown', () => {
  it('cabeçalho com tipo, subtítulo e período em pt-BR', () => {
    const md = toMarkdown(doc())
    expect(md).toContain('# Sprint S1')
    expect(md).toContain('> **Relatório de sprint** · alfa · encerrada')
    expect(md).toContain('Período: 06/07/2026 – 10/07/2026 · gerado em 20/07/2026')
  })

  it('kpis viram tabela de uma linha, com dicas em itálico', () => {
    const md = toMarkdown(doc({
      sections: [{ title: 'Resumo', blocks: [{ kind: 'kpis', items: [{ label: 'Concluídos', value: '2 de 3', hint: '67%' }, { label: 'Custo', value: 'US$ 2,00' }] }] }],
    }))
    expect(md).toContain('| Concluídos | Custo |\n| :---: | :---: |\n| **2 de 3** | **US$ 2,00** |\n| _67%_ |   |')
  })

  it('tabela escapa pipe e alinha colunas numéricas à direita', () => {
    const md = toMarkdown(doc({
      sections: [{ title: 'T', blocks: [{ kind: 'table', columns: ['Card', 'Custo'], rows: [['a | b', '1,00']], numeric: [1] }] }],
    }))
    expect(md).toContain('| Card | Custo |\n| --- | ---: |\n| a \\| b | 1,00 |')
  })

  it('gráfico vira xychart do mermaid com eixo folgado e legenda de séries', () => {
    const md = toMarkdown(doc({
      sections: [{
        title: 'P',
        blocks: [{ kind: 'chart', chart: 'line', title: 'Concluídos "acumulado"', labels: ['06/07', '07/07'], series: [{ name: 'Feitos', values: [1, 2] }, { name: 'Escopo', values: [3, 3] }] }],
      }],
    }))
    expect(md).toContain("```mermaid\nxychart-beta\n  title \"Concluídos 'acumulado'\"\n  x-axis [\"06/07\", \"07/07\"]\n  y-axis \"\" 0 --> 4\n  line [1, 2]\n  line [3, 3]\n```")
    expect(md).toContain('_Séries: Feitos · Escopo_')
  })

  it('gráfico sem dados vira frase, não bloco quebrado', () => {
    const md = toMarkdown(doc({ sections: [{ title: 'P', blocks: [{ kind: 'chart', chart: 'bar', title: 'Entregas', labels: [], series: [] }] }] }))
    expect(md).toContain('_Entregas: sem dados no período._')
    expect(md).not.toContain('xychart')
  })

  it('análise leva o aviso de IA e não sobe acima de ###', () => {
    const md = toMarkdown(doc({
      sections: [{ title: 'Análise', blocks: [{ kind: 'analysis', markdown: '# Resumo\n\ntexto', provider: 'claude-cli', model: null, generated_at: '2026-07-20T12:00:00.000Z' }] }],
    }))
    expect(md).toContain('Análise gerada por IA (claude-cli) em 20/07/2026')
    expect(md).toContain('### Resumo')
    expect(md).not.toMatch(/^# Resumo/m)
  })

  it('gerado em usa o dia local: 01:23Z do dia 28 ainda é 27 em Brasília', () => {
    expect(toMarkdown(doc({ generated_at: '2026-09-28T01:23:00.000Z' }))).toContain('gerado em 27/09/2026')
  })

  it('notas fecham o documento', () => {
    expect(toMarkdown(doc({ notes: ['Nota A'] }))).toMatch(/## Notas metodológicas\n\n- Nota A\n$/)
  })
})

describe('análise', () => {
  it('prompt leva só os fatos e as regras de não inventar número', () => {
    const p = buildAnalysisPrompt(doc(), { escopo: { cards: 3 } })
    expect(p).toContain('Use SOMENTE os fatos do JSON')
    expect(p).toContain('"cards": 3')
    expect(p).toContain('"### Resumo"')
  })

  it('cleanAnalysis tira cerca de código em volta da resposta', () => {
    expect(cleanAnalysis('```markdown\n### Resumo\nok\n```')).toBe('### Resumo\nok')
    expect(cleanAnalysis('  ### Resumo  ')).toBe('### Resumo')
  })

  it('demoteHeadings mantém ### e sobe # e ## para ###', () => {
    expect(demoteHeadings('# A\n## B\n### C\n#### D')).toBe('### A\n### B\n### C\n#### D')
  })
})
