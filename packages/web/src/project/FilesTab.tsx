import { useOutletContext } from 'react-router-dom'
import { Files } from '../files/Files.js'
import type { ProjectOutletContext } from './ProjectLayout.js'

export function FilesTab() {
  const { client, project } = useOutletContext<ProjectOutletContext>()
  return <Files client={client} fixedProject={project} />
}
