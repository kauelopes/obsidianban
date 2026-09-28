import type { ModulePageProps, ModuleProjectTabProps, WebModule } from '@obsidiankan/module-sdk/web'
import { ReportsView } from './ReportsView.js'
import { ReportsSettings } from './ReportsSettings.js'
import './reports.css'

function ReportsPage({ host }: ModulePageProps) {
  return <ReportsView host={host} />
}

function ReportsTab({ host, project }: ModuleProjectTabProps) {
  return <ReportsView host={host} project={project} />
}

export const reportsWebModule: WebModule = {
  id: 'reports',
  page: { navLabel: 'Relatórios', component: ReportsPage },
  projectTab: { label: 'Relatórios', component: ReportsTab },
  settingsPanel: ReportsSettings,
}
