import { useCallback, useMemo, useState } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router-dom'
import type { CardSummary } from '@obsidiankan/types'
import { KanbanClient } from './api/client.js'
import { errorText } from './api/result.js'
import { Board } from './board/Board.js'
import { useBoard } from './board/useBoard.js'
import { CardDetail } from './card/CardDetail.js'
import { TokenGate, useToken } from './TokenGate.js'

function BoardPage({ client }: { client: KanbanClient }) {
  const board = useBoard(client)
  const [hint, setHint] = useState<string | null>(null)

  /**
   * UX hint only. The plugin duplicated server rules as if they were law; here
   * they just explain why a drop looks wrong. The server remains the authority
   * and its 409 is what actually decides.
   */
  const moveHint = useCallback(
    (card: CardSummary, toStatus: string): string | null => {
      if (toStatus === card.status) return null
      const advancing = ['in_progress', 'review', 'done'].includes(toStatus)
      if (advancing && card.blocked_by.length > 0) {
        return `bloqueado por ${card.blocked_by.join(', ')}`
      }
      const project = board.projects.find((p) => p.project === card.project)
      const sprint = project?.sprints.find((s) => s.id === card.sprint_id)
      if (advancing && sprint && sprint.status !== 'active') {
        return `sprint "${sprint.name}" não está ativa`
      }
      return null
    },
    [board.projects],
  )

  const onMove = useCallback(
    async (card: CardSummary, toStatus: string) => {
      const previous = card.status
      // Optimistic: the card jumps immediately, and the SSE echo (or the
      // rollback below) reconciles with what the server actually decided.
      board.setCards((prev) =>
        prev.map((c) => (c.id === card.id ? { ...c, status: toStatus } : c)),
      )
      const res = await client.moveCard({
        id: card.id,
        version: card.version,
        to_status: toStatus,
        // A human dragging a card costs no tokens; 'human' keeps the move
        // distinguishable from agent activity in /metrics.
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

  return (
    <div className="app">
      <div className="topbar">
        <h1><Link to="/">ObsidianKan</Link></h1>
        <div className="spacer" />
        {hint && <span className="empty">{hint}</span>}
        <span className={`conn ${board.conn}`}>{board.conn}</span>
      </div>
      {board.error && <p className="banner">{board.error}</p>}
      {board.loading ? (
        <p className="empty" style={{ padding: 16 }}>carregando o board…</p>
      ) : (
        <Board
          groups={board.groups}
          onMove={onMove}
          moveHint={moveHint}
          onMoveHintChange={setHint}
        />
      )}
    </div>
  )
}

export function App() {
  const { token, setToken, clearToken } = useToken()
  const client = useMemo(() => (token ? new KanbanClient({ token }) : null), [token])

  if (!client) return <TokenGate onSubmit={setToken} />

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<BoardPage client={client} />} />
        <Route
          path="/card/:id"
          element={
            <div className="app">
              <div className="topbar">
                <h1><Link to="/">ObsidianKan</Link></h1>
                <div className="spacer" />
                <button onClick={clearToken}>trocar token</button>
              </div>
              <CardDetail client={client} />
            </div>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
