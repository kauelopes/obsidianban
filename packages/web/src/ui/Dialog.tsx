import { useEffect, type ReactNode } from 'react'

/**
 * One dialog replaces the plugin's per-purpose modal classes. The plugin had
 * 14 files under src/ui/ that differed only in their form fields; the shell is
 * the same every time.
 */
export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal>
        <header>
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="fechar">×</button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  )
}
