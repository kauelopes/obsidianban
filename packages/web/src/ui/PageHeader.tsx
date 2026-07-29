import type { ReactNode } from 'react'

/**
 * Ações e controles específicos da rota atual — o que a topbar deixou de
 * carregar. Mesmo espírito do Dialog: o shell é sempre igual, o conteúdo é
 * de quem chama.
 */
export function PageHeader({ children }: { children: ReactNode }) {
  return <div className="page-header">{children}</div>
}
