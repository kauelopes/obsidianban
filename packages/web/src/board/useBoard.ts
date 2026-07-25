import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CardSummary, Sprint } from '@obsidiankan/types'
import { KanbanClient } from '../api/client.js'
import { type ConnectionState, subscribe } from '../api/events.js'
import { errorText } from '../api/result.js'
import { groupBoard, removeCard, upsertCard, type ProjectShape } from './group.js'

export interface ProjectInfo {
  project: string
  columns: string[]
  archived: boolean
  sprints: Sprint[]
}

export function useBoard(client: KanbanClient) {
  const [cards, setCards] = useState<readonly CardSummary[]>([])
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [sprintFilter, setSprintFilter] = useState<Record<string, string | undefined>>({})
  const [conn, setConn] = useState<ConnectionState>('connecting')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // The SSE handler is registered once; without a ref it would close over the
  // first render's client and never see a token change.
  const clientRef = useRef(client)
  clientRef.current = client

  const loadProjects = useCallback(async () => {
    const res = await clientRef.current.listProjects()
    if (!res.ok) {
      // A dev/pm token cannot list projects (manager-only). The board still
      // works: column order falls back to the default and projects are
      // inferred from the cards themselves.
      setProjects([])
      return
    }
    setProjects(
      res.data.projects.map((p) => ({
        project: p.project,
        columns: p.columns,
        archived: p.archived,
        sprints: p.sprints ?? [],
      })),
    )
  }, [])

  const loadCards = useCallback(async () => {
    const res = await clientRef.current.listCards({ limit: 200 })
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setError(null)
    setCards(res.data.cards)
  }, [])

  const refreshCard = useCallback(async (id: string) => {
    const res = await clientRef.current.getCard(id)
    if (!res.ok) return
    const { body: _body, ...summary } = res.data
    setCards((prev) => upsertCard(prev, summary as CardSummary))
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await Promise.all([loadProjects(), loadCards()])
      setLoading(false)
    })()
  }, [loadProjects, loadCards])

  useEffect(() => {
    return subscribe(
      (ev) => {
        const cardId = typeof ev.payload['card_id'] === 'string' ? ev.payload['card_id'] : null
        switch (ev.type) {
          case 'CARD_DELETED':
            if (cardId) setCards((prev) => removeCard(prev, cardId))
            break
          case 'CARD_CREATED':
          case 'CARD_UPDATED':
          case 'CARD_MOVED':
          case 'CARD_HUMAN_EDITED':
          case 'CARD_ARCHIVED':
          case 'CARD_UNARCHIVED':
            // Re-read the single card instead of trusting the payload: it is
            // authoritative and keeps the rest of the board untouched.
            if (cardId) void refreshCard(cardId)
            break
          case 'CARD_REORDERED':
            void loadCards()
            break
          default:
            // Project and sprint events change board shape, not card content.
            void loadProjects()
            break
        }
      },
      setConn,
    )
  }, [refreshCard, loadCards, loadProjects])

  const shapes: ProjectShape[] = useMemo(
    () =>
      projects
        .filter((p) => !p.archived)
        .map((p) => ({
          project: p.project,
          columns: p.columns,
          archived: p.archived,
          sprints: p.sprints,
          selectedSprint: sprintFilter[p.project],
        })),
    [projects, sprintFilter],
  )

  const groups = useMemo(() => groupBoard(cards, shapes), [cards, shapes])

  return {
    groups,
    projects,
    conn,
    error,
    loading,
    sprintFilter,
    setSprintFilter,
    setCards,
    reload: loadCards,
    setError,
  }
}
