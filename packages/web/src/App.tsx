import { useCallback, useMemo, useState } from 'react'
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from 'react-router-dom'
import type { CardSummary, Sprint } from '@obsidiankan/types'
import { KanbanClient } from './api/client.js'
import { errorText } from './api/result.js'
import { Board } from './board/Board.js'
import { useBoard } from './board/useBoard.js'
import { CardDetail } from './card/CardDetail.js'
import { Help } from './help/Help.js'
import { Home } from './home/Home.js'
import { Inbox } from './inbox/Inbox.js'
import { Metrics } from './metrics/Metrics.js'
import { ThemeContext } from './markdown/Markdown.js'
import { PlanEntry, PlanWizard } from './plan/PlanWizard.js'
import { usePlanningSummary } from './plan/usePlanningSummary.js'
import { CreateCard } from './ui/CreateCard.js'
import { CreateProject } from './ui/CreateProject.js'
import { ProjectPanel } from './ui/ProjectPanel.js'
import { SprintPanel } from './ui/SprintPanel.js'
import { ThemeToggle, useTheme } from './ui/theme.js'
import { TokenGate, useToken } from './TokenGate.js'

export function Shell({
  children,
  right,
  onLogout,
  client,
}: {
  children: React.ReactNode
  right?: React.ReactNode
  onLogout: () => void
  client: KanbanClient
}) {
  const { pref, cycle } = useTheme()
  // Sessão de planejamento é estado do vault, não de uma página — a pill
  // acompanha o usuário em qualquer rota para a jornada nunca se perder.
  const planning = usePlanningSummary(client)
  return (
    <div className="app">
      <div className="topbar">
        <h1 className="brand">
          <Link to="/">ObsidianKan</Link>
        </h1>
        <nav className="tabs-nav">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>
            Home
          </NavLink>
          <NavLink to="/inbox" className={({ isActive }) => (isActive ? 'active' : '')}>
            Escalações
          </NavLink>
          <NavLink to="/atividade" className={({ isActive }) => (isActive ? 'active' : '')}>
            Atividade
          </NavLink>
          <NavLink to="/ajuda" className={({ isActive }) => (isActive ? 'active' : '')}>
            Ajuda
          </NavLink>
        </nav>
        <div className="spacer" />
        {planning && (
          <NavLink to="/planejar" className="pill planning topbar-plan">
            ◇ planejando: {planning.project_name ?? 'novo projeto'}
          </NavLink>
        )}
        {right}
        <ThemeToggle pref={pref} cycle={cycle} />
        <button className="ghost" onClick={onLogout}>
          sair
        </button>
      </div>
      {children}
    </div>
  )
}

function HomePage({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
  const board = useBoard(client)
  const navigate = useNavigate()
  const [creatingProject, setCreatingProject] = useState(false)
  // Sessão de planejamento em andamento muda o rótulo do botão — a rota
  // /planejar retoma a sessão ativa por conta própria de qualquer forma.
  const planning = usePlanningSummary(client)
  return (
    <Shell
      client={client}
      onLogout={onLogout}
      right={
        <>
          <button className="primary" onClick={() => navigate('/planejar')}>
            {planning ? 'continuar planejamento' : 'planejar projeto'}
          </button>
          <button onClick={() => setCreatingProject(true)}>+ projeto</button>
          <span className={`conn ${board.conn}`}>{board.conn}</span>
        </>
      }
    >
      {board.error && (
        <p className="banner">
          {board.error}
          <button className="ghost" onClick={() => void board.reload()}>
            tentar de novo
          </button>
          <button className="ghost" onClick={() => board.setError(null)}>
            fechar
          </button>
        </p>
      )}
      <Home
        client={client}
        board={board}
        onCreateProject={() => setCreatingProject(true)}
        onPlanProject={() => navigate('/planejar')}
      />
      {creatingProject && (
        <CreateProject
          client={client}
          onClose={() => setCreatingProject(false)}
          onCreated={board.reload}
        />
      )}
    </Shell>
  )
}

function BoardPage({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
  const { project = '' } = useParams()
  const navigate = useNavigate()
  const board = useBoard(client, { project })
  const [creatingIn, setCreatingIn] = useState<string | null>(null)
  const [sprintsIn, setSprintsIn] = useState<string | null>(null)
  const [projectIn, setProjectIn] = useState<string | null>(null)
  const [query, setQuery] = useState('')

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
        return `sprint “${sprint.name}” não está ativa`
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

  const knownProjects = board.projects.filter((p) => !p.archived).map((p) => p.project)
  const notFound =
    !board.loading &&
    board.groups.length === 0 &&
    knownProjects.length > 0 &&
    !knownProjects.includes(project)

  return (
    <Shell
      client={client}
      onLogout={onLogout}
      right={
        <>
          {/* Token de dev não enxerga listProjects: sem lista, sem seletor. */}
          {knownProjects.length > 1 && (
            <select
              aria-label="Trocar de projeto"
              value={project}
              onChange={(e) => navigate(`/board/${e.target.value}`)}
            >
              {!knownProjects.includes(project) && <option value={project}>{project}</option>}
              {knownProjects.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          )}
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
          <span className={`conn ${board.conn}`}>{board.conn}</span>
        </>
      }
    >
      {board.error && (
        <p className="banner">
          {board.error}
          <button className="ghost" onClick={() => board.setError(null)}>
            fechar
          </button>
        </p>
      )}
      {board.loading ? (
        <p className="empty-lg">carregando o board…</p>
      ) : notFound ? (
        <p className="empty-lg">
          O projeto <strong>{project}</strong> não existe (ou foi arquivado).{' '}
          <Link to="/">← voltar para a home</Link>
        </p>
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
    <Shell client={client} onLogout={onLogout}>
      <CardDetail client={client} sprintsFor={sprintsFor} cardsFor={cardsFor} />
    </Shell>
  )
}

export function App() {
  const { token, setToken, clearToken } = useToken()
  const client = useMemo(() => (token ? new KanbanClient({ token }) : null), [token])
  const { resolved } = useTheme()

  if (!client) return <TokenGate onSubmit={setToken} />

  return (
    <ThemeContext.Provider value={resolved}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage client={client} onLogout={clearToken} />} />
          <Route path="/board/:project" element={<BoardPage client={client} onLogout={clearToken} />} />
          <Route path="/board" element={<Navigate to="/" replace />} />
          <Route path="/card/:id" element={<CardPage client={client} onLogout={clearToken} />} />
          <Route
            path="/planejar"
            element={
              <Shell client={client} onLogout={clearToken}>
                <PlanEntry client={client} />
              </Shell>
            }
          />
          <Route
            path="/planejar/:sessionId"
            element={
              <Shell client={client} onLogout={clearToken}>
                <PlanWizard client={client} />
              </Shell>
            }
          />
          <Route
            path="/inbox"
            element={
              <Shell client={client} onLogout={clearToken}>
                <Inbox client={client} />
              </Shell>
            }
          />
          <Route
            path="/ajuda"
            element={
              <Shell client={client} onLogout={clearToken}>
                <Help />
              </Shell>
            }
          />
          <Route
            path="/atividade"
            element={
              <Shell client={client} onLogout={clearToken}>
                <Metrics client={client} />
              </Shell>
            }
          />
        </Routes>
      </BrowserRouter>
    </ThemeContext.Provider>
  )
}
