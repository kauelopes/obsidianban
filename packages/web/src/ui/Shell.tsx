import { Link, NavLink } from 'react-router-dom'
import type { KanbanClient } from '../api/client.js'
import { usePlanningSummary } from '../plan/usePlanningSummary.js'
import { ThemeToggle, useTheme } from './theme.js'

export function Shell({
  children,
  status,
  onLogout,
  client,
}: {
  children: React.ReactNode
  /** Estado global mínimo — ex. badge de conexão. Ações de página vão em PageHeader, não aqui. */
  status?: React.ReactNode
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
          <NavLink to="/projetos" className={({ isActive }) => (isActive ? 'active' : '')}>
            Projetos
          </NavLink>
          <NavLink to="/horizonte" className={({ isActive }) => (isActive ? 'active' : '')}>
            Horizonte
          </NavLink>
          <NavLink to="/atividade" className={({ isActive }) => (isActive ? 'active' : '')}>
            Estatísticas
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
        {status}
        <ThemeToggle pref={pref} cycle={cycle} />
        <button className="ghost" onClick={onLogout}>
          sair
        </button>
      </div>
      {children}
    </div>
  )
}
