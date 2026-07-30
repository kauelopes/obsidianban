import { useCallback, useEffect, useRef, useState } from 'react'
import type { SprintPlanningSessionView } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { subscribe } from '../api/events.js'
import { errorText } from '../api/result.js'

const POLL_MS = 3000

/**
 * Estado da sessão do wizard de sprint: carrega via sprintPlanningGet, assina
 * os eventos SPRINT_PLANNING_* (filtrados por session_id) e mantém um polling
 * de 3s enquanto status === 'generating' — mesmo padrão de usePlanning.
 */
export function useSprintPlanning(client: KanbanClient, sessionId: string) {
  const [session, setSession] = useState<SprintPlanningSessionView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const sessionRef = useRef<SprintPlanningSessionView | null>(null)
  sessionRef.current = session

  const reload = useCallback(async () => {
    const res = await client.sprintPlanningGet(sessionId)
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
      if (!e.type.startsWith('SPRINT_PLANNING_')) return
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
