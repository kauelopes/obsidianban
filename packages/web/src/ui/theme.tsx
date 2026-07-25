import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'system' | 'light' | 'dark'
export type Resolved = 'light' | 'dark'

const KEY = 'obsidiankan.theme'

function readPref(): ThemePref {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

function systemTheme(): Resolved {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * Três estados, não dois: 'system' precisa ser distinguível de uma escolha
 * explícita que por acaso coincide com o sistema, senão o toggle deixa de
 * seguir o SO depois do primeiro clique.
 *
 * O atributo data-theme só é escrito quando a preferência é explícita — sem
 * ele o CSS cai na media query, que é o comportamento de 'system'.
 */
export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(readPref)
  const [system, setSystem] = useState<Resolved>(systemTheme)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => setSystem(mq.matches ? 'light' : 'dark')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: Resolved = pref === 'system' ? system : pref

  useEffect(() => {
    const root = document.documentElement
    if (pref === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', pref)
  }, [pref])

  const cycle = useCallback(() => {
    setPref((p) => {
      const next: ThemePref = p === 'system' ? 'light' : p === 'light' ? 'dark' : 'system'
      if (next === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, next)
      return next
    })
  }, [])

  return { pref, resolved, cycle }
}

export function ThemeToggle({ pref, cycle }: { pref: ThemePref; cycle: () => void }) {
  const label = pref === 'system' ? 'sistema' : pref === 'light' ? 'claro' : 'escuro'
  return (
    <button
      className="ghost mono"
      onClick={cycle}
      title="Alternar tema: sistema → claro → escuro"
      aria-label={`Tema: ${label}. Clique para alternar.`}
      style={{ fontSize: 'var(--t-2xs)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-label)' }}
    >
      tema: {label}
    </button>
  )
}
