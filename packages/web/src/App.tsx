import { useMemo, useState } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import type { CardSummary, Sprint } from '@obsidiankan/types'
import { KanbanClient } from './api/client.js'
import { CardDetail } from './card/CardDetail.js'
import { useBoard } from './board/useBoard.js'
import { Configs } from './configs/Configs.js'
import { Dashboard } from './home/Dashboard.js'
import { Home } from './home/Home.js'
import { Horizon } from './horizon/Horizon.js'
import { Metrics } from './metrics/Metrics.js'
import { ThemeContext } from './markdown/Markdown.js'
import { PlanEntry, PlanWizard } from './plan/PlanWizard.js'
import { usePlanningSummary } from './plan/usePlanningSummary.js'
import { BoardTab } from './project/BoardTab.js'
import { FilesTab } from './project/FilesTab.js'
import { GoalsTab } from './project/GoalsTab.js'
import { MetricsTab } from './project/MetricsTab.js'
import { ProjectLayout } from './project/ProjectLayout.js'
import { SprintPlanEntry, SprintPlanWizard } from './sprint-plan/SprintPlanWizard.js'
import { CreateProject } from './ui/CreateProject.js'
import { PageHeader } from './ui/PageHeader.js'
import { Shell } from './ui/Shell.js'
import { useTheme } from './ui/theme.js'
import { TokenGate, useToken } from './TokenGate.js'

function DashboardPage({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
  const board = useBoard(client)
  return (
    <Shell
      client={client}
      onLogout={onLogout}
      status={<span className={`conn ${board.conn}`}>{board.conn}</span>}
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
      <Dashboard client={client} board={board} />
    </Shell>
  )
}

function ProjectsPage({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
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
      status={<span className={`conn ${board.conn}`}>{board.conn}</span>}
    >
      <PageHeader>
        <button className="primary" onClick={() => navigate('/planejar')}>
          {planning ? 'continuar planejamento' : 'planejar projeto'}
        </button>
        <button onClick={() => setCreatingProject(true)}>+ projeto</button>
      </PageHeader>
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

function CardPage({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
  // The detail view needs the project's sprints and sibling cards for the
  // sprint picker and the blocked_by autocomplete.
  const board = useBoard(client)
  const sprintsFor = (project: string): readonly Sprint[] =>
    board.projects.find((p) => p.project === project)?.sprints ?? []
  const cardsFor = (project: string): readonly CardSummary[] =>
    board.groups.filter((g) => g.project === project).flatMap((g) => Object.values(g.cards).flat())

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
          <Route path="/" element={<DashboardPage client={client} onLogout={clearToken} />} />
          <Route path="/projetos" element={<ProjectsPage client={client} onLogout={clearToken} />} />
          <Route path="/board/:project" element={<ProjectLayout client={client} onLogout={clearToken} />}>
            <Route index element={<BoardTab />} />
            <Route path="arquivos" element={<FilesTab />} />
            <Route path="estatisticas" element={<MetricsTab />} />
            <Route path="metas" element={<GoalsTab />} />
          </Route>
          <Route path="/board" element={<Navigate to="/projetos" replace />} />
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
            path="/projetos/:project/planejar-sprint"
            element={
              <Shell client={client} onLogout={clearToken}>
                <SprintPlanEntry client={client} />
              </Shell>
            }
          />
          <Route
            path="/planejar-sprint/:sessionId"
            element={
              <Shell client={client} onLogout={clearToken}>
                <SprintPlanWizard client={client} />
              </Shell>
            }
          />
          <Route path="/inbox" element={<Navigate to="/" replace />} />
          <Route
            path="/horizonte"
            element={
              <Shell client={client} onLogout={clearToken}>
                <Horizon client={client} />
              </Shell>
            }
          />
          <Route path="/revisao" element={<Navigate to="/atividade" replace />} />
          <Route path="/ajuda" element={<Navigate to="/configs" replace />} />
          <Route
            path="/configs"
            element={
              <Shell client={client} onLogout={clearToken}>
                <Configs client={client} />
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
          <Route path="/arquivos" element={<Navigate to="/projetos" replace />} />
        </Routes>
      </BrowserRouter>
    </ThemeContext.Provider>
  )
}
