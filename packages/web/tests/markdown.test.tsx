import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/markdown/Markdown.js'
import { parseLogEntries } from '@obsidiankan/types'

/**
 * Casos de conteúdo que existem de verdade no test-vault, mais o de MathJax que
 * NÃO existe em nenhum card dos dois vaults — ou seja, math nunca havia sido
 * exercitado por nada neste repositório, apesar de ser uma decisão explícita do
 * PRD (MathJax em vez de KaTeX, por fidelidade ao Obsidian).
 */

describe('Markdown', () => {
  it('renderiza MathJax em bloco — não havia fixture para isto em nenhum vault', async () => {
    const { container } = render(<Markdown>{'Seja $$E = mc^2$$ a relação.'}</Markdown>)
    // rehype-mathjax emite <mjx-container>. Se o plugin sair da cadeia, isto
    // vira texto cru e o teste quebra.
    await waitFor(() => {
      expect(container.querySelector('mjx-container')).toBeTruthy()
    })
  })

  it('renderiza math inline', async () => {
    const { container } = render(<Markdown>{'A área é $\\pi r^2$ no plano.'}</Markdown>)
    await waitFor(() => {
      expect(container.querySelector('mjx-container')).toBeTruthy()
    })
  })

  it('aplica a classe de prosa serif só quando pedido', () => {
    const { container: plain } = render(<Markdown>texto</Markdown>)
    expect(plain.querySelector('.md')?.classList.contains('prose')).toBe(false)

    const { container: prose } = render(<Markdown prose>texto</Markdown>)
    expect(prose.querySelector('.md.prose')).toBeTruthy()
  })

  it('não interpreta HTML cru — rehype-raw fica desligado de propósito', () => {
    render(<Markdown>{'<img src=x onerror="alert(1)">'}</Markdown>)
    // O HTML aparece como texto, não como elemento.
    expect(document.querySelector('img')).toBeNull()
  })

  it('mostra estado vazio em vez de um bloco em branco', () => {
    render(<Markdown>{'   \n  '}</Markdown>)
    expect(screen.getByText('vazio')).toBeTruthy()
  })

  it('renderiza tabela GFM e task list', () => {
    const { container } = render(
      <Markdown>{'| a | b |\n|---|---|\n| 1 | 2 |\n\n- [ ] pendente\n- [x] feito'}</Markdown>,
    )
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
  })

  it('bloco mermaid inválido cai para o código-fonte em vez de desaparecer', async () => {
    const bad = '```mermaid\nisto não é um diagrama {{{\n```'
    const { container } = render(<Markdown>{bad}</Markdown>)
    // O fallback é <pre><code>; o conteúdo do card nunca some da tela.
    await waitFor(() => {
      expect(container.querySelector('pre code')).toBeTruthy()
    })
  })
})

describe('log corrompido do test-vault', () => {
  it('renderiza sem lançar, com as barras-n literais do card-ZqL78oc6', () => {
    // Conteudo real do vault: o entry foi gravado com barras-n literais em vez
    // de quebras de linha. Tem de degradar, nao quebrar. O parse em si e
    // testado no pacote normativo; aqui o que importa e o render.
    const real =
      '**2026-05-31T20:33:49Z**\n\n## Teste de Markdown\\n\\nEste log testa **negrito**' +
      '\\n\\n```mermaid\\ngraph TD\\n  A[Agente] --> B[Claim Card]\\n```"'
    const [entry] = parseLogEntries(real)
    expect(entry!.ts).toBe('2026-05-31T20:33:49Z')
    expect(() => render(<Markdown>{entry!.text}</Markdown>)).not.toThrow()
  })
})
