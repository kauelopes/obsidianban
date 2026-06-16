import { Notice } from 'obsidian'

const DEFAULT_DURATION_MS = 5000
const RETRY_DURATION_MS = 8000

/** Brief, non-actionable error toast. Auto-dismisses. */
export function showErrorToast(message: string): void {
  new Notice(message, DEFAULT_DURATION_MS)
}

/** Error toast with a "Retry" button. The button dismisses the toast and
 *  invokes the callback. */
export function showRetryToast(message: string, onRetry: () => void | Promise<void>): void {
  const frag = document.createDocumentFragment()
  const span = document.createElement('span')
  span.textContent = message + ' '
  frag.appendChild(span)
  const btn = document.createElement('button')
  btn.textContent = 'Retry'
  btn.className = 'mod-cta kanban-mcp-toast-retry'
  frag.appendChild(btn)
  const notice = new Notice(frag, RETRY_DURATION_MS)
  btn.addEventListener('click', async () => {
    notice.hide()
    await onRetry()
  })
}
