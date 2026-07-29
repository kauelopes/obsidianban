import { useCallback, useEffect, useRef, useState } from 'react'
import type { PlanningSessionView } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { subscribe } from '../api/events.js'
import { errorText } from '../api/result.js'

const POLL_MS = 3000

/**
 * Estado da sessão de planejamento: carrega via planningGet, assina os eventos
 * PLANNING_* (filtrados por session_id) e mantém um polling de 3s enquanto
 * status === 'generating' — o SSE é o caminho rápido, o polling o fallback.
 */
export function usePlanning(client: KanbanClient, sessionId: string) {
  const [session, setSession] = useState<PlanningSessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef<PlanningSessionView | null>(null)
  sessionRef.current = session

  const reload = useCallback(async () => {
    const res = await client.planningGet(sessionId)
    if (res.ok) {
      setSession(res.data)
      setError(null)
    } else {
      setError(errorText(res.error))
    }
    setLoading(false)
  }, [client, sessionId])

  useEffect(() => {
    void reload()
    const unsubscribe = subscribe((e) => {
      if (!e.type.startsWith('PLANNING_')) return
      if (e.payload['session_id'] !== sessionId) return
      void reload()
    })
    return unsubscribe
  }, [reload, sessionId])

  useEffect(() => {
    if (session?.status !== 'generating') return
    const timer = setInterval(() => void reload(), POLL_MS)
    return () => clearInterval(timer)
  }, [session?.status, reload])

  return { session, error, loading, reload, setSession, setError }
}
