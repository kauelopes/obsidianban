import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CardSummary, EscalationItem, Sprint } from '@obsidiankan/types'
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

/**
 * Com `project`, cards e shapes ficam restritos a ele — e o limite de 200 do
 * servidor passa a valer POR projeto, não pelo vault inteiro. Sem `project`
 * (home), carrega tudo como antes.
 */
export function useBoard(client: KanbanClient, opts: { project?: string } = {}) {
  const { project } = opts
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
    // kanban_list_projects returns only project shape (columns, archived,
    // target_repo) — sprints live in _meta.json and come from their own tool,
    // one call per project.
    const withSprints = await Promise.all(
      res.data.projects.map(async (p) => {
        const s = await clientRef.current.listSprints({ project: p.project, status: 'all' })
        return {
          project: p.project,
          columns: p.columns,
          archived: p.archived,
          sprints: s.ok ? s.data.sprints : [],
        }
      }),
    )
    setProjects(withSprints)
  }, [])

  // kanban_list_cards hides archived cards by default. Closing a sprint
  // auto-archives everything in 'done', so a project whose sprints are all
  // closed looks completely empty without this toggle — which is exactly what
  // the plugin's showArchived existed for.
  // sessionStorage, não useState puro: entrar num card e voltar remonta o
  // hook, e perder o filtro a cada navegação custava re-descobrir onde estava.
  const [showArchived, setShowArchived] = useState(
    () => sessionStorage.getItem('kanban.showArchived') === '1',
  )
  const showArchivedRef = useRef(showArchived)
  showArchivedRef.current = showArchived
  useEffect(() => {
    sessionStorage.setItem('kanban.showArchived', showArchived ? '1' : '0')
  }, [showArchived])

  const loadCards = useCallback(async () => {
    const res = await clientRef.current.listCards({
      ...(project ? { project } : {}),
      limit: 200,
      include_archived: showArchivedRef.current,
    })
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setError(null)
    setCards(res.data.cards)
  }, [project])

  useEffect(() => {
    void loadCards()
  }, [showArchived, loadCards])

  const refreshCard = useCallback(async (id: string) => {
    const res = await clientRef.current.getCard(id)
    if (!res.ok) return
    const { body: _body, ...summary } = res.data
    setCards((prev) => upsertCard(prev, summary as CardSummary))
  }, [])

  /**
   * Ids com escalação pendente, para o board poder marcá-los.
   *
   * Vem de kanban_list_escalations — a MESMA fonte da inbox, então o board e a
   * inbox nunca discordam. A alternativa seria carregar o log de cada card na
   * listagem, que é o caminho quente do board; uma chamada só resolve.
   */
  // Itens completos, não só ids: a home precisa de reason/projeto/prioridade.
  // O Set continua derivado para o board marcar cards sem reprocessar nada.
  const [escalations, setEscalations] = useState<readonly EscalationItem[]>([])
  const escalated: ReadonlySet<string> = useMemo(
    () => new Set(escalations.map((e) => e.card_id)),
    [escalations],
  )

  const loadEscalations = useCallback(async () => {
    const res = await clientRef.current.listEscalations()
    // Um token de dev não enxerga esta tool. O board segue sem as marcas em vez
    // de mostrar erro por algo que é sinal informativo, não conteúdo.
    if (!res.ok) return
    setEscalations(res.data.escalations)
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await Promise.all([loadProjects(), loadCards(), loadEscalations()])
      setLoading(false)
    })()
  }, [loadProjects, loadCards, loadEscalations])

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
            // Um CARD_UPDATED pode ter sido justamente uma entrada de log que
            // escalou ou resolveu, e o payload não diz. Reconsultar é o que
            // mantém a marca do board igual à inbox.
            if (ev.type === 'CARD_UPDATED') void loadEscalations()
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
  }, [refreshCard, loadCards, loadProjects, loadEscalations])

  const shapes: ProjectShape[] = useMemo(
    () =>
      projects
        .filter((p) => !p.archived)
        .filter((p) => !project || p.project === project)
        .map((p) => ({
          project: p.project,
          columns: p.columns,
          archived: p.archived,
          sprints: p.sprints,
          selectedSprint: sprintFilter[p.project],
        })),
    [projects, sprintFilter, project],
  )

  const groups = useMemo(() => groupBoard(cards, shapes), [cards, shapes])

  return {
    groups,
    cards,
    projects,
    conn,
    error,
    loading,
    sprintFilter,
    setSprintFilter,
    showArchived,
    setShowArchived,
    setCards,
    escalated,
    escalations,
    reload: loadCards,
    reloadEscalations: loadEscalations,
    setError,
  }
}
