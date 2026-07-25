import { useCallback, useState } from 'react'

const KEY = 'obsidiankan.token'

/**
 * D4 in the PRD: the plugin wrote raw tokens into _kanban-secrets/<project>.md
 * inside the vault, where they sat in plaintext and got synced along with
 * everything else. The web app keeps the token in localStorage instead — still
 * readable by anything running on this origin, but it never lands in the vault
 * and never reaches git.
 */
export function useToken() {
  const [token, setTokenState] = useState<string | null>(() => localStorage.getItem(KEY))

  const setToken = useCallback((t: string) => {
    localStorage.setItem(KEY, t)
    setTokenState(t)
  }, [])

  const clearToken = useCallback(() => {
    localStorage.removeItem(KEY)
    setTokenState(null)
  }, [])

  return { token, setToken, clearToken }
}

export function TokenGate({ onSubmit }: { onSubmit: (t: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="gate">
      <h1>Token do kanban</h1>
      <p>
        Cole um token de manager para ver todos os projetos. Gere um com{' '}
        <code>kanban-token create --role manager --actor human:seunome</code>.
      </p>
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
