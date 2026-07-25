import { useCallback, useState } from 'react'

const KEY = 'obsidiankan.token'
const SUPPRESS = 'obsidiankan.no-session'

declare global {
  interface Window {
    /** Injetado pelo servidor no index.html quando servido no loopback. */
    __KANBAN_SESSION__?: string
  }
}

/**
 * D4 in the PRD: the plugin wrote raw tokens into _kanban-secrets/<project>.md
 * inside the vault, where they sat in plaintext and got synced along with
 * everything else. The web app keeps the token in localStorage instead — still
 * readable by anything running on this origin, but it never lands in the vault
 * and never reaches git.
 *
 * Acima disso vem a sessão injetada: o servidor cunha um token em memória ao
 * subir e o entrega dentro do próprio index.html, então o caso normal não pede
 * nada a ninguém. Ordem de precedência, e o motivo de cada uma:
 *
 * 1. Token colado à mão vence — explícito ganha de implícito, e é assim que se
 *    entra com um token de agente para conferir o que ele enxerga.
 * 2. Sessão injetada, salvo se o "sair" desta aba a tiver dispensado. A marca
 *    fica em sessionStorage, não em localStorage: sair é sobre esta aba, e um
 *    navegador reaberto volta ao caso normal em vez de guardar rancor.
 */
export function useToken() {
  const [token, setTokenState] = useState<string | null>(() => {
    const stored = localStorage.getItem(KEY)
    if (stored) return stored
    if (sessionStorage.getItem(SUPPRESS)) return null
    return window.__KANBAN_SESSION__ ?? null
  })

  const setToken = useCallback((t: string) => {
    localStorage.setItem(KEY, t)
    sessionStorage.removeItem(SUPPRESS)
    setTokenState(t)
  }, [])

  const clearToken = useCallback(() => {
    localStorage.removeItem(KEY)
    sessionStorage.setItem(SUPPRESS, '1')
    setTokenState(null)
  }, [])

  return { token, setToken, clearToken }
}

export function TokenGate({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [value, setValue] = useState('')
  const hasSession = Boolean(window.__KANBAN_SESSION__)

  return (
    <div className="gate">
      <h1>Token do kanban</h1>
      {hasSession ? (
        <p>
          Você saiu da sessão local desta aba. Recarregue a página para voltar a
          ela, ou cole um token específico — de agente, por exemplo — para ver o
          kanban com as permissões dele.
        </p>
      ) : (
        <p>
          Cole um token de manager para ver todos os projetos. Gere um com{' '}
          <code>kanban-token create --role manager --actor human:seunome</code>.
        </p>
      )}
      <input
        type="password"
        value={value}
        placeholder="cole o token aqui"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value.trim() && onSubmit(value.trim())}
      />
      <button className="primary" disabled={!value.trim()} onClick={() => onSubmit(value.trim())}>
        Entrar
      </button>
    </div>
  )
}
