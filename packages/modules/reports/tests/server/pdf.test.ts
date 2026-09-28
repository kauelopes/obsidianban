import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { ReportDocument } from '../../server/api-types.js'
import { PdfRenderer, defaultRendererDir, resolvePython } from '../../server/pdf.js'

const rendererDir = defaultRendererDir()
const python = resolvePython({}, rendererDir)
// Só roda com o venv do renderer (make reports-setup); sem ele, o comportamento
// de "indisponível" é coberto logo abaixo.
const hasRenderer = existsSync(path.join(rendererDir, '.venv', 'bin', 'python'))

const DOC: ReportDocument = {
  kicker: 'Relatório de sprint',
  title: 'Sprint <S1> & cia',
  subtitle: 'alfa · encerrada',
  period: { from: '2026-07-06', to: '2026-07-10' },
  generated_at: '2026-07-20T12:00:00.000Z',
  sections: [
    {
      title: 'Resumo',
      lead: 'Visão geral',
      blocks: [
        { kind: 'kpis', items: [{ label: 'Concluídos', value: '2 de 3', hint: '67%' }, { label: 'Custo', value: 'US$ 4,50' }] },
        { kind: 'paragraph', text: 'Texto com <b>tag</b> que deve sair escapado.' },
        { kind: 'callout', title: 'Objetivo', text: 'Entregar o login', tone: 'info' },
        { kind: 'callout', title: 'Esperando decisão', text: 'Card X', tone: 'warn' },
        { kind: 'list', items: ['um', 'dois'] },
      ],
    },
    {
      title: 'Análise',
      blocks: [
        {
          kind: 'analysis',
          markdown: '### Resumo\n\nFoi **bem**. <script>alert(1)</script>\n\n### Riscos\n\n- atraso\n- custo',
          provider: 'claude-cli',
          model: null,
          generated_at: '2026-07-20T12:00:00.000Z',
        },
      ],
    },
    {
      title: 'Gráficos',
      blocks: [
        { kind: 'chart', chart: 'line', title: 'Burn-up', labels: ['06/07', '07/07', '08/07'], series: [{ name: 'Feitos', values: [0, 1, 2] }, { name: 'Escopo', values: [3, 3, 3] }] },
        { kind: 'chart', chart: 'bar', title: 'Por projeto', labels: ['alfa-projeto', 'beta-projeto'], series: [{ name: 'Entregas', values: [5, 3] }] },
        { kind: 'chart', chart: 'bar', title: 'Semanas', labels: ['S1', 'S2'], series: [{ name: 'Entregas', values: [5, 3] }, { name: 'Custo', values: [1, 2] }] },
        { kind: 'chart', chart: 'bar', title: 'Vazio', labels: ['a'], series: [{ name: 'x', values: [0] }] },
        { kind: 'table', columns: ['Card', 'Custo'], rows: [['a | <b>', 'US$ 1,00']], numeric: [1], caption: 'Mais caros' },
        { kind: 'table', columns: ['Nada'], rows: [] },
      ],
    },
  ],
  notes: ['Nota metodológica.'],
}

let dir: string
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reports-pdf-'))
})
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe.skipIf(!hasRenderer)('renderer Python (WeasyPrint)', () => {
  it('status disponível com o venv', async () => {
    expect(await new PdfRenderer(python, rendererDir).status()).toMatchObject({ available: true, reason: null })
  })

  it('gera PDF com todos os tipos de bloco', async () => {
    const out = path.join(dir, 'r.pdf')
    const res = await new PdfRenderer(python, rendererDir).render(DOC, { brand: 'Minha Marca' }, out)
    expect(res).toEqual({ ok: true, error: null })
    const head = (await fs.readFile(out)).subarray(0, 5).toString('latin1')
    expect(head).toBe('%PDF-')
  })

  it('escapa texto do vault e HTML devolvido pelo LLM; aplica o tema', async () => {
    const out = path.join(dir, 'h.pdf')
    const r = spawnSync(python, [path.join(rendererDir, 'cli.py'), '--out', out, '--html'], {
      input: JSON.stringify({ document: DOC, theme: { brand: 'Minha "Marca"', footer: 'Rodapé "x"' } }),
    })
    expect(r.status, r.stderr.toString()).toBe(0)
    const html = await fs.readFile(path.join(dir, 'h.html'), 'utf8')
    expect(html).toContain('Sprint &lt;S1&gt; &amp; cia')
    expect(html).toContain('&lt;b&gt;tag&lt;/b&gt;')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toContain('<strong>bem</strong>')
    expect(html).toContain('<li>atraso</li>')
    expect(html).toContain('Minha &quot;Marca&quot;')
    expect(html).toContain('content: "Rodapé \\"x\\""')
    expect(html).toContain('Vazio: sem dados no período.')
    // generated_at 12:00Z → 09h em Brasília, mesmo dia; a capa mostra 20/07
    expect(html).toContain('Gerado em 20/07/2026')
  })
})

describe('renderer indisponível', () => {
  it('python inexistente vira status com motivo e render sem PDF', async () => {
    const r = new PdfRenderer('/nao/existe/python', rendererDir)
    const st = await r.status()
    expect(st.available).toBe(false)
    expect(st.reason).toMatch(/python indisponível .*make reports-setup/)
    const res = await r.render(DOC, {}, path.join(dir, 'x.pdf'))
    expect(res.ok).toBe(false)
    expect(existsSync(path.join(dir, 'x.pdf'))).toBe(false)
  })

  it('python sem weasyprint aponta o make reports-setup', async () => {
    const st = await new PdfRenderer('python3', rendererDir).status()
    if (st.available) return // máquina com weasyprint global: nada a verificar
    expect(st.reason).toMatch(/dependências do renderer ausentes|python indisponível/)
  })

  it('REPORTS_PYTHON tem prioridade sobre o venv', () => {
    expect(resolvePython({ REPORTS_PYTHON: '/opt/py' }, rendererDir)).toBe('/opt/py')
  })
})
