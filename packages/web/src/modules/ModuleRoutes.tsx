import { Link, useOutletContext, useParams } from 'react-router-dom'
import type { ProjectOutletContext } from '../project/ProjectLayout.js'
import { useModules } from './ModulesContext.js'

function Inactive({ moduleId, loading }: { moduleId: string; loading: boolean }) {
  if (loading) return <p className="empty">carregando módulo…</p>
  return (
    <p className="empty-lg">
      O módulo <strong>{moduleId}</strong> não está ativo.{' '}
      <Link to="/configs?secao=modulos">Ativar em Configs → Módulos</Link>
    </p>
  )
}

/** /m/:moduleId — página global de um módulo. */
export function ModulePage() {
  const { moduleId = '' } = useParams()
  const { active, loading } = useModules()
  const mod = active.find((m) => m.info.id === moduleId)
  if (!mod?.web.page) return <Inactive moduleId={moduleId} loading={loading} />
  const Page = mod.web.page.component
  return <Page host={mod.host} />
}

/** /board/:project/m/:moduleId — aba de um módulo no workspace do projeto. */
export function ModuleProjectTab() {
  const { moduleId = '' } = useParams()
  const { project } = useOutletContext<ProjectOutletContext>()
  const { active, loading } = useModules()
  const mod = active.find((m) => m.info.id === moduleId)
  if (!mod?.web.projectTab) return <Inactive moduleId={moduleId} loading={loading} />
  const Tab = mod.web.projectTab.component
  return <Tab key={project} host={mod.host} project={project} />
}
