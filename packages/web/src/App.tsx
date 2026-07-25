import { useCallback, useMemo, useState } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import type { CardSummary, Sprint } from '@obsidiankan/types'
import { KanbanClient } from './api/client.js'
import { errorText } from './api/result.js'
import { Board } from './board/Board.js'
import { useBoard } from './board/useBoard.js'
import { CardDetail } from './card/CardDetail.js'
import { CreateCard } from './ui/CreateCard.js'
import { SprintPanel } from './ui/SprintPanel.js'
import { TokenGate, useToken } from './TokenGate.js'

function Shell({
  children,
  right,
}: {
  children: React.ReactNode
  right?: React.ReactNode
}) {
  return (
    <div className="app">
      <div className="topbar">
        <h1><Link to="/">ObsidianKan</Link></h1>
        <div className="spacer" />
        {right}
      </div>
      {children}
    </div>
  )
}

function BoardPage({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
  const board = useBoard(client)
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [sprintsIn, setSprintsIn] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const sprintsFor = useCallback(
    (project: string): readonly Sprint[] =>
      board.projects.find((p) => p.project === project)?.sprints ?? [],
    [board.projects],
  )

  /**
   * UX hint only. The plugin duplicated server rules as if they were law; here
   * they explain why a drop looks wrong. The server's 409 is what decides.
   */
  const moveHint = useCallback(
    (card: CardSummary, toStatus: string): string | null => {
      if (toStatus === card.status) return null
      const advancing = ['in_progress', 'review', 'done'].includes(toStatus)
      if (advancing && card.blocked_by.length > 0) {
        return `bloqueado por ${card.blocked_by.length} card(s)`
      }
      const sprint = sprintsFor(card.project).find((s) => s.id === card.sprint_id)
      if (advancing && sprint && sprint.status !== 'active') {
        return `sprint "${sprint.name}" não está ativa`
      }
      return null
    },
    [sprintsFor],
  )

  const onMove = useCallback(
    async (card: CardSummary, toStatus: string) => {
      const previous = card.status
      board.setCards((prev) =>
        prev.map((c) => (c.id === card.id ? { ...c, status: toStatus } : c)),
      )
      const res = await client.moveCard({
        id: card.id,
        version: card.version,
        to_status: toStatus,
        input_tokens: 0,
        output_tokens: 0,
        model: 'human',
      })
      if (!res.ok) {
        board.setCards((prev) =>
          prev.map((c) => (c.id === card.id ? { ...c, status: previous } : c)),
        )
        board.setError(errorText(res.error))
        if (res.error.kind === 'conflict') void board.reload()
      } else {
        board.setError(null)
      }
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
    <Shell
      right={
        <>
          <input
            className="search"
            value={query}
            placeholder="buscar título, tag, assignee…"
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
          <span className={`conn ${board.conn}`}>{board.conn}</span>
          <button onClick={onLogout}>sair</button>
        </>
      }
    >
      {board.error && <p className="banner">{board.error}</p>}
      {board.loading ? (
        <p className="empty" style={{ padding: 16 }}>carregando o board…</p>
      ) : (
        <Board
          groups={groups}
          onMove={onMove}
          moveHint={moveHint}
          onCreateCard={setCreatingIn}
          onOpenSprints={setSprintsIn}
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
          onClose={() => setSprintsIn(null)}
          onChanged={board.reload}
        />
      )}
    </Shell>
  )
}

function CardPage({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
  // The detail view needs the project's sprints and sibling cards for the
  // sprint picker and the blocked_by autocomplete.
  const board = useBoard(client)
  const sprintsFor = useCallback(
    (project: string): readonly Sprint[] =>
      board.projects.find((p) => p.project === project)?.sprints ?? [],
    [board.projects],
  )
  const cardsFor = useCallback(
    (project: string): readonly CardSummary[] =>
      board.groups
        .filter((g) => g.project === project)
        .flatMap((g) => Object.values(g.cards).flat()),
    [board.groups],
  )

  return (
    <Shell right={<button onClick={onLogout}>sair</button>}>
      <CardDetail client={client} sprintsFor={sprintsFor} cardsFor={cardsFor} />
    </Shell>
  )
}

export function App() {
  const { token, setToken, clearToken } = useToken()
  const client = useMemo(() => (token ? new KanbanClient({ token }) : null), [token])

  if (!client) return <TokenGate onSubmit={setToken} />

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<BoardPage client={client} onLogout={clearToken} />} />
        <Route path="/card/:id" element={<CardPage client={client} onLogout={clearToken} />} />
      </Routes>
    </BrowserRouter>
  )
}
