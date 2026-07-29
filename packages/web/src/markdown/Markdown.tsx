import { createContext, useContext, useEffect, useId, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeMathjax from 'rehype-mathjax'
import mermaid from 'mermaid'
import type { Resolved } from '../ui/theme.js'

/**
 * O tema resolvido chega por contexto porque o mermaid é um singleton com
 * estado global: só dá para ter uma configuração por vez, e ela precisa ser
 * reaplicada antes de cada render. Antes o tema era fixo em 'dark', o que
 * deixava todo diagrama ilegível no tema claro.
 */
export const ThemeContext = createContext<Resolved>('dark')

// securityLevel 'strict' is mermaid's own default: it escapes HTML in labels
// and ignores click directives. Left explicit so a future edit has to be
// deliberate about weakening it. rehype-raw is intentionally NOT enabled.
function configure(theme: Resolved): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'light' ? 'neutral' : 'dark',
    fontFamily: "'IBM Plex Sans Variable', system-ui, sans-serif",
  })
}

function MermaidBlock({ code }: { code: string }) {
  const theme = useContext(ThemeContext)
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setParseError(null)
    // Reconfigurar a cada render: outro bloco pode ter reconfigurado o
    // singleton com outro tema entre um render e o próximo.
    configure(theme)
    mermaid
      .render(`m${id}`, code)
      .then((r) => alive && setSvg(r.svg))
      .catch((err: unknown) => alive && setParseError(err instanceof Error ? err.message : String(err)))
    return () => {
      alive = false
    }
  }, [code, id, theme])

  // A diagram that fails to parse falls back to its source rather than
  // vanishing — the text is the card's content either way. The parse error is
  // shown so the reader knows it's broken syntax, not intentional raw text.
  if (parseError !== null) {
    return (
      <div className="mermaid-invalid">
        <p className="mermaid-invalid-notice">diagrama mermaid inválido — exibindo o código-fonte</p>
        <p className="mermaid-invalid-detail">{parseError}</p>
        <pre>
          <code>{code}</code>
        </pre>
      </div>
    )
  }
  if (svg === null) {
    return (
      <pre>
        <code>{code}</code>
      </pre>
    )
  }
  return <div className="mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
}

/**
 * MathJax over KaTeX is a fidelity call: the existing cards were written and
 * proofread inside Obsidian, which renders $...$ and $$...$$ with MathJax 3.
 * The larger bundle and async typesetting are irrelevant on localhost.
 */
export function Markdown({ children, prose = false }: { children: string; prose?: boolean }) {
  if (!children.trim()) return <p className="empty">vazio</p>

  return (
    <div className={prose ? 'md prose' : 'md'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeMathjax]}
        components={{
          code(props) {
            const { className, children: kids, ...rest } = props
            const lang = /language-(\w+)/.exec(className ?? '')?.[1]
            const text = String(kids).replace(/\n$/, '')
            if (lang === 'mermaid') return <MermaidBlock code={text} />
            return (
              <code className={className} {...rest}>
                {kids}
              </code>
            )
          },
          a(props) {
            return <a {...props} target="_blank" rel="noreferrer noopener" />
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
