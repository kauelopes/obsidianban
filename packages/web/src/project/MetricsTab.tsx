import { useOutletContext } from 'react-router-dom'
import { ProjectMetrics } from '../metrics/ProjectMetrics.js'
import type { ProjectOutletContext } from './ProjectLayout.js'

export function MetricsTab() {
  const { client, project } = useOutletContext<ProjectOutletContext>()
  return <ProjectMetrics client={client} project={project} />
}
