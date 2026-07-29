import { useEffect, useState } from 'react'
import type { PlanningSessionView } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'

/**
 * Sessão de planejamento ativa (se houver) — snapshot no mount. Alimenta o
 * rótulo do botão da Home, o card do aside e a pill da topbar; a rota
 * /planejar retoma a sessão por conta própria, então aqui só se lê.
 */
export function usePlanningSummary(client: KanbanClient): PlanningSessionView | null {
  const [session, setSession] = useState<PlanningSessionView | null>(null)
  useEffect(() => {
    let alive = true
    void client.planningList().then((res) => {
      if (alive && res.ok) setSession(res.data.sessions[0] ?? null)
    })
    return () => {
      alive = false
    }
  }, [client])
  return session
}
