import type { Block, ReportDocument } from './api-types.js'
import { fmtDate, fmtPeriod } from './format.js'

/**
 * ReportDocument → Markdown. É o que a interface mostra (renderizador do core,
 * com GFM e mermaid) e o que dá para abrir no Obsidian. Gráficos saem como
 * `xychart-beta` do mermaid — o mesmo dado que o PDF desenha com matplotlib.
 */
export function toMarkdown(doc: ReportDocument): string {
  const out: string[] = []
  out.push(`# ${inline(doc.title)}`, '')
  out.push(`> **${inline(doc.kicker)}** · ${inline(doc.subtitle)}  `)
  out.push(`> Período: ${fmtPeriod(doc.period)} · gerado em ${fmtDate(doc.generated_at)}`, '')

  for (const section of doc.sections) {
    out.push(`## ${inline(section.title)}`, '')
    if (section.lead) out.push(`_${inline(section.lead)}_`, '')
    for (const block of section.blocks) out.push(...renderBlock(block), '')
  }

  if (doc.notes.length > 0) {
    out.push('## Notas metodológicas', '')
    for (const n of doc.notes) out.push(`- ${inline(n)}`)
    out.push('')
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

function renderBlock(b: Block): string[] {
  switch (b.kind) {
    case 'paragraph':
      return [inline(b.text)]
    case 'list':
      return b.items.map((i) => `- ${inline(i)}`)
    case 'kpis': {
      const head = `| ${b.items.map((i) => cell(i.label)).join(' | ')} |`
      const sep = `| ${b.items.map(() => ':---:').join(' | ')} |`
      const vals = `| ${b.items.map((i) => `**${cell(i.value)}**`).join(' | ')} |`
      const rows = [head, sep, vals]
      if (b.items.some((i) => i.hint)) rows.push(`| ${b.items.map((i) => (i.hint ? `_${cell(i.hint)}_` : ' ')).join(' | ')} |`)
      return rows
    }
    case 'table': {
      if (b.rows.length === 0) return ['_sem linhas_']
      const numeric = new Set(b.numeric ?? [])
      const rows = [
        `| ${b.columns.map(cell).join(' | ')} |`,
        `| ${b.columns.map((_, i) => (numeric.has(i) ? '---:' : '---')).join(' | ')} |`,
        ...b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`),
      ]
      return b.caption ? [`**${inline(b.caption)}**`, '', ...rows] : rows
    }
    case 'chart':
      return renderChart(b)
    case 'callout': {
      const label = b.tone === 'warn' ? `Atenção — ${b.title}` : b.title
      return [`> **${inline(label)}**  `, `> ${inline(b.text)}`]
    }
    case 'analysis':
      return [
        `> _Análise gerada por IA (${inline(b.provider)}${b.model ? ` · ${inline(b.model)}` : ''}) em ${fmtDate(b.generated_at)} a partir dos números deste relatório. Leia como interpretação, não como dado._`,
        '',
        demoteHeadings(b.markdown.trim()),
      ]
  }
}

function renderChart(b: Extract<Block, { kind: 'chart' }>): string[] {
  const numbers = b.series.flatMap((s) => s.values)
  if (b.labels.length === 0 || numbers.length === 0) return [`_${inline(b.title)}: sem dados no período._`]
  const max = Math.max(...numbers, 0)
  const mark = b.chart === 'bar' ? 'bar' : 'line'
  const lines = [
    '```mermaid',
    'xychart-beta',
    `  title "${quote(b.title)}"`,
    `  x-axis [${b.labels.map((l) => `"${quote(l)}"`).join(', ')}]`,
    `  y-axis "${quote(b.unit?.trim() ?? '')}" 0 --> ${niceMax(max)}`,
    ...b.series.map((s) => `  ${mark} [${s.values.map(num).join(', ')}]`),
    '```',
  ]
  if (b.series.length > 1) lines.push('', `_Séries: ${b.series.map((s) => inline(s.name)).join(' · ')}_`)
  return lines
}

/** Topo do eixo um pouco acima do máximo — senão o mermaid cola a série no teto. */
function niceMax(max: number): number {
  if (max <= 0) return 1
  const padded = max * 1.1
  const mag = 10 ** Math.floor(Math.log10(padded))
  return Math.ceil(padded / mag) * mag
}

function num(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '0'
}

function quote(s: string): string {
  return s.replace(/"/g, "'").replace(/\n/g, ' ')
}

/** Texto em linha: quebra de linha vira espaço (senão quebra blockquote e tabela). */
function inline(s: string): string {
  return s.replace(/\r?\n+/g, ' ').trim()
}

function cell(s: string): string {
  return inline(s).replace(/\|/g, '\\|') || ' '
}

/** O documento já usa # e ##; título da análise abaixo de ### sobe para ###. */
export function demoteHeadings(md: string): string {
  return md.replace(/^(#{1,6})(\s)/gm, (_m, hashes: string, sp: string) => `${'#'.repeat(Math.max(3, hashes.length))}${sp}`)
}
