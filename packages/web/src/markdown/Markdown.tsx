import { useEffect, useId, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeMathjax from 'rehype-mathjax'
import mermaid from 'mermaid'

// securityLevel 'strict' is mermaid's own default: it escapes HTML in labels
// and ignores click directives. Left explicit so a future edit has to be
// deliberate about weakening it. rehype-raw is intentionally NOT enabled.
mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' })

function MermaidBlock({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    mermaid
      .render(`m${id}`, code)
      .then((r) => alive && setSvg(r.svg))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [code, id])

  // A diagram that fails to parse falls back to its source rather than
  // vanishing — the text is the card's content either way.
  if (failed || svg === null) {
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
export function Markdown({ children }: { children: string }) {
  const ref = useRef<HTMLDivElement>(null)
  if (!children.trim()) return <p className="empty">vazio</p>

  return (
    <div className="md" ref={ref}>
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
