import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { CardSummary } from '@obsidiankan/types'
import { errorText } from '../api/result.js'
import { Board } from '../board/Board.js'
import { CreateCard } from '../ui/CreateCard.js'
import { ProjectPanel } from '../ui/ProjectPanel.js'
import { SprintPanel } from '../ui/SprintPanel.js'
import type { ProjectOutletContext } from './ProjectLayout.js'

/**
 * Aba índice do workspace do projeto — o kanban em si. `board`, `sprintsFor`
 * e `cardsFor` vêm do ProjectLayout (uma única `useBoard` por projeto, não
 * uma por aba); esta aba só cuida do que é específico dela: busca, toggle de
 * arquivados, drag-and-drop e os diálogos de criar card / sprints / ajustes.
 */
export function BoardTab() {
  const { client, board, sprintsFor, cardsFor } = useOutletContext<ProjectOutletContext>()
  const navigate = useNavigate()
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [sprintsIn, setSprintsIn] = useState<string | null>(null)
  const [projectIn, setProjectIn] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const moveHint = useCallback(
    (card: CardSummary, toStatus: string): string | null => {
      if (toStatus === card.status) return null
      const advancing = ['in_progress', 'review', 'done'].includes(toStatus)
      if (advancing && card.blocked_by.length > 0) {
        return `bloqueado por ${card.blocked_by.length} card(s)`
      }
      const sprint = sprintsFor(card.project).find((s) => s.id === card.sprint_id)
      if (advancing && sprint && sprint.status !== 'active') {
        return `sprint “${sprint.name}” não está ativa`
      }
      return null
    },
    [sprintsFor],
  )

  const onMove = useCallback(
    async (card: CardSummary, toStatus: string) => {
      const previous = card.status
      board.setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, status: toStatus } : c)))
      const res = await client.moveCard({
        id: card.id,
        version: card.version,
        to_status: toStatus,
        input_tokens: 0,
        output_tokens: 0,
        model: 'human',
      })
      if (!res.ok) {
        board.setCards((prev) => prev.map((c) => (c.id === card.id ? { ...c, status: previous } : c)))
        board.setError(errorText(res.error))
        if (res.error.kind === 'conflict') void board.reload()
      } else {
        board.setError(null)
      }
    },
    [board, client],
  )

  /**
   * Reorder não é otimista: kanban_reorder_card renumera e sobe a `version` de
   * todos os outros cards da coluna, então adivinhar o resultado no cliente
   * garantiria uma cascata de 409 no próximo movimento. Recarregamos.
   */
  const onReorder = useCallback(
    async (card: CardSummary, afterCardId: string | null) => {
      const res = await client.reorderCard({
        id: card.id,
        version: card.version,
        after_card_id: afterCardId,
        input_tokens: 0,
        output_tokens: 0,
        model: 'human',
      })
      if (!res.ok) board.setError(errorText(res.error))
      else board.setError(null)
      void board.reload()
    },
    [board, client],
  )

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return board.groups
    return board.groups.map((g) => ({
      ...g,
      cards: Object.fromEntries(
        Object.entries(g.cards).map(([status, cards]) => [
          status,
          cards.filter(
            (c) =>
              c.title.toLowerCase().includes(q) ||
              c.tags.some((t) => t.toLowerCase().includes(q)) ||
              (c.assigned_to ?? '').toLowerCase().includes(q) ||
              c.id.toLowerCase().includes(q),
          ),
        ]),
      ),
    }))
  }, [board.groups, query])

  return (
    <>
      <div className="form-row filters" style={{ marginBottom: 'var(--s-4)' }}>
        <input
          className="search"
          value={query}
          placeholder="buscar título, tag, responsável…"
          aria-label="Buscar cards"
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="toggle" title="Fechar uma sprint arquiva os cards em done">
          <input
            type="checkbox"
            checked={board.showArchived}
            onChange={(e) => board.setShowArchived(e.target.checked)}
          />
          arquivados
        </label>
      </div>

      {board.loading ? (
        <p className="empty-lg">carregando o board…</p>
      ) : (
        <Board
          groups={groups}
          onMove={onMove}
          onReorder={onReorder}
          escalated={board.escalated}
          showArchived={board.showArchived}
          onShowArchived={board.setShowArchived}
          moveHint={moveHint}
          onCreateCard={setCreatingIn}
          onOpenSprints={setSprintsIn}
          onPlanSprint={(project) => navigate(`/projetos/${project}/planejar-sprint`)}
          onOpenProject={setProjectIn}
          sprintFilter={board.sprintFilter}
          onSprintFilter={(project, sprintId) =>
            board.setSprintFilter((prev) => ({ ...prev, [project]: sprintId }))
          }
          sprintsFor={sprintsFor}
        />
      )}

      {creatingIn && (
        <CreateCard
          client={client}
          project={creatingIn}
          sprints={sprintsFor(creatingIn)}
          onClose={() => setCreatingIn(null)}
          onCreated={board.reload}
        />
      )}
      {sprintsIn && (
        <SprintPanel
          client={client}
          project={sprintsIn}
          sprints={sprintsFor(sprintsIn)}
          cards={cardsFor(sprintsIn)}
          onClose={() => setSprintsIn(null)}
          onChanged={board.reload}
        />
      )}
      {projectIn && (
        <ProjectPanel
          client={client}
          project={projectIn}
          onClose={() => setProjectIn(null)}
          onChanged={board.reload}
        />
      )}
    </>
  )
}
