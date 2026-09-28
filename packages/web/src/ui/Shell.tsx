import { Link, NavLink } from 'react-router-dom'
import type { KanbanClient } from '../api/client.js'
import { usePlanningSummary } from '../plan/usePlanningSummary.js'
import { useModules } from '../modules/ModulesContext.js'

const CORE_NAV: ReadonlyArray<{ to: string; label: string }> = [
  { to: '/projetos', label: 'Projetos' },
  { to: '/horizonte', label: 'Horizonte' },
  { to: '/atividade', label: 'Estatísticas' },
]

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
  // Sessão de planejamento é estado do vault, não de uma página — a pill
  // acompanha o usuário em qualquer rota para a jornada nunca se perder.
  const planning = usePlanningSummary(client)
  // Módulos ativos entram entre as seções do core e Configs, que fecha a barra.
  const { active } = useModules()
  const nav = [
    ...CORE_NAV,
    ...active.flatMap((m) => (m.web.page ? [{ to: `/m/${m.info.id}`, label: m.web.page.navLabel }] : [])),
    { to: '/configs', label: 'Configs' },
  ]
  return (
    <div className="app">
      <div className="topbar">
        <h1 className="brand">
          <Link to="/">ObsidianKan</Link>
        </h1>
        <nav className="tabs-nav">
          {nav.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? 'active' : '')}>
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        {planning && (
          <NavLink to="/planejar" className="pill planning topbar-plan">
            ◇ planejando: {planning.project_name ?? 'novo projeto'}
          </NavLink>
        )}
        {status}
        <button className="ghost" onClick={onLogout}>
          sair
        </button>
      </div>
      {children}
    </div>
  )
}
