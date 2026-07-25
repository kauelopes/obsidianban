import { renderHook, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useToken } from '../src/TokenGate.js'

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  delete window.__KANBAN_SESSION__
})

afterEach(() => {
  delete window.__KANBAN_SESSION__
})

describe('useToken — precedência', () => {
  it('usa a sessão injetada quando não há nada colado', () => {
    window.__KANBAN_SESSION__ = 'sess-abc'
    const { result } = renderHook(() => useToken())
    expect(result.current.token).toBe('sess-abc')
  })

  it('token colado vence a sessão injetada', () => {
    window.__KANBAN_SESSION__ = 'sess-abc'
    localStorage.setItem('obsidiankan.token', 'colado')
    const { result } = renderHook(() => useToken())
    expect(result.current.token).toBe('colado')
  })

  it('a sessão nunca é copiada para o localStorage', () => {
    window.__KANBAN_SESSION__ = 'sess-abc'
    renderHook(() => useToken())
    expect(localStorage.getItem('obsidiankan.token')).toBeNull()
  })

  it('sair dispensa a sessão nesta aba, e o gate aparece', () => {
    window.__KANBAN_SESSION__ = 'sess-abc'
    const { result } = renderHook(() => useToken())
    act(() => result.current.clearToken())
    expect(result.current.token).toBeNull()

    // Recarregar a aba mantém a dispensa — é isso que faz "sair" significar algo.
    const remontado = renderHook(() => useToken())
    expect(remontado.result.current.token).toBeNull()
  })

  it('colar um token depois de sair volta a valer', () => {
    window.__KANBAN_SESSION__ = 'sess-abc'
    const { result } = renderHook(() => useToken())
    act(() => result.current.clearToken())
    act(() => result.current.setToken('token-de-agente'))
    expect(result.current.token).toBe('token-de-agente')
    expect(sessionStorage.getItem('obsidiankan.no-session')).toBeNull()
  })

  it('sem sessão injetada, segue o comportamento antigo', () => {
    const { result } = renderHook(() => useToken())
    expect(result.current.token).toBeNull()
    act(() => result.current.setToken('manual'))
    expect(localStorage.getItem('obsidiankan.token')).toBe('manual')
  })
})
