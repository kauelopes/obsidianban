import { useCallback } from 'react'
import { Link, NavLink, Outlet, useNavigate, useParams } from 'react-router-dom'
import type { CardSummary, Sprint } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { useBoard } from '../board/useBoard.js'
import { Shell } from '../ui/Shell.js'
import { PageHeader } from '../ui/PageHeader.js'
import { AgentsStatusBar } from '../ui/AgentsStatusBar.js'
import { useModules } from '../modules/ModulesContext.js'

export interface ProjectOutletContext {
  client: KanbanClient
  project: string
  board: ReturnType<typeof useBoard>
  sprintsFor: (project: string) => readonly Sprint[]
  cardsFor: (project: string) => readonly CardSummary[]
  knownProjects: string[]
}

const TABS: ReadonlyArray<{ to: string; label: string; end: boolean }> = [
  { to: '', label: 'Board', end: true },
  { to: 'arquivos', label: 'Arquivos', end: false },
  { to: 'estatisticas', label: 'Estatísticas', end: false },
  { to: 'metas', label: 'Metas', end: false },
]

/**
 * Workspace de um projeto — Board, Arquivos, Estatísticas e Metas viviam
 * espalhados entre uma rota top-level e um modal de ajustes; aqui viram abas
 * de um mesmo lugar, com o board carregado UMA vez (não uma por aba) e
 * repassado via Outlet context. AgentsStatusBar fica fixa acima de todas as
 * abas — "tem agente rodando agora" é relevante em qualquer uma delas, não
 * só no board.
 */
export function ProjectLayout({ client, onLogout }: { client: KanbanClient; onLogout: () => void }) {
  const { project = '' } = useParams()
  const navigate = useNavigate()
  const board = useBoard(client, { project })
  const { active } = useModules()
  const tabs = [
    ...TABS,
    ...active.flatMap((m) =>
      m.web.projectTab ? [{ to: `m/${m.info.id}`, label: m.web.projectTab.label, end: false }] : [],
    ),
  ]

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
      status={<span className={`conn ${board.conn}`}>{board.conn}</span>}
    >
      <PageHeader>
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
      </PageHeader>

      {project && knownProjects.includes(project) && (
        <AgentsStatusBar client={client} project={project} sprints={sprintsFor(project)} />
      )}

      {board.error && (
        <p className="banner">
          {board.error}
          <button className="ghost" onClick={() => board.setError(null)}>
            fechar
          </button>
        </p>
      )}

      {notFound ? (
        <p className="empty-lg">
          O projeto <strong>{project}</strong> não existe (ou foi arquivado).{' '}
          <Link to="/projetos">← voltar para projetos</Link>
        </p>
      ) : (
        <div className="project-workspace">
          <nav className="project-nav" aria-label="Seções do projeto">
            {tabs.map((t) => (
              <NavLink
                key={t.label}
                to={`/board/${project}${t.to ? `/${t.to}` : ''}`}
                end={t.end}
                className={({ isActive }) => (isActive ? 'active' : undefined)}
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="project-content">
            <Outlet
              context={
                { client, project, board, sprintsFor, cardsFor, knownProjects } satisfies ProjectOutletContext
              }
            />
          </div>
        </div>
      )}
    </Shell>
  )
}
