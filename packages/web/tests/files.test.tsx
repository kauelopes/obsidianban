import { render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KanbanClient } from '../src/api/client.js'
import { Files } from '../src/files/Files.js'

const PROJECTS = { projects: [{ project: 'demo', columns: [], archived: false }] }
const KAD_FILES = {
  project: 'demo',
  files: [
    { id: 'vision', label: 'Visão', mtime: '2026-01-01T00:00:00Z' },
    { id: 'prd', label: 'PRD', mtime: '2026-01-02T00:00:00Z' },
  ],
}
const KAD_DOC = { project: 'demo', doc: 'vision', content: '# Visão do produto\n\nTexto.' }
const REPO_FILES = {
  project: 'demo',
  files: [{ id: 'adr/0001-stack', label: 'adr/0001-stack', mtime: '2026-01-03T00:00:00Z' }],
}
const REPO_DOC = { project: 'demo', doc: 'adr/0001-stack', content: '# ADR 0001\n\nEscolha de stack.' }

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as Response
}

function mount(opts: {
  projects?: unknown
  kadFiles?: unknown
  kadDoc?: unknown
  repoFiles?: unknown
  repoFilesStatus?: number
  repoDoc?: unknown
  projectsStatus?: number
} = {}) {
  const projects = opts.projects ?? PROJECTS
  const kadFiles = opts.kadFiles ?? KAD_FILES
  const kadDoc = opts.kadDoc ?? KAD_DOC
  const repoFiles = opts.repoFiles ?? { project: 'demo', files: [] }
  const repoFilesStatus = opts.repoFilesStatus ?? 200
  const repoDoc = opts.repoDoc ?? REPO_DOC
  const projectsStatus = opts.projectsStatus ?? 200

  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/mcp/tool/kanban_list_projects')) return jsonResponse(projectsStatus, projects)
    if (url.includes('/vault/kad/doc')) return jsonResponse(200, kadDoc)
    if (url.includes('/vault/kad')) return jsonResponse(200, kadFiles)
    if (url.includes('/vault/repo-docs/doc')) return jsonResponse(200, repoDoc)
    if (url.includes('/vault/repo-docs')) return jsonResponse(repoFilesStatus, repoFiles)
    throw new Error(`unexpected fetch: ${url}`)
  })
  return render(<Files client={new KanbanClient({ token: 'tok' })} />)
}

describe('Files', () => {
  it('lista os documentos KAD do projeto selecionado', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('Visão')).toBeTruthy())
    expect(screen.getByText('PRD')).toBeTruthy()
  })

  it('clicar num documento KAD busca e renderiza o markdown', async () => {
    mount()
    await waitFor(() => expect(screen.getByText('Visão')).toBeTruthy())
    screen.getByText('Visão').click()
    await waitFor(() => expect(screen.getByText('Visão do produto')).toBeTruthy())
  })

  it('mostra também os docs do repositório, numa seção separada', async () => {
    mount({ repoFiles: REPO_FILES })
    await waitFor(() => expect(screen.getByText('docs/ do repositório')).toBeTruthy())
    expect(screen.getByText('adr/0001-stack')).toBeTruthy()

    screen.getByText('adr/0001-stack').click()
    await waitFor(() => expect(screen.getByText('ADR 0001')).toBeTruthy())
  })

  it('projeto sem target_repo não quebra — seção docs/ some, KAD segue normal', async () => {
    mount({ repoFiles: { error: 'not_found' }, repoFilesStatus: 404 })
    await waitFor(() => expect(screen.getByText('Visão')).toBeTruthy())
    expect(screen.queryByText('docs/ do repositório')).toBeNull()
  })

  it('projeto sem nenhum documento mostra estado vazio, não erro', async () => {
    mount({ kadFiles: { project: 'demo', files: [] }, repoFiles: { project: 'demo', files: [] } })
    await waitFor(() =>
      expect(screen.getByText(/ainda não tem documentos KAD nem docs\//)).toBeTruthy(),
    )
  })

  it('token sem acesso a listProjects cai para campo de texto livre', async () => {
    mount({ projectsStatus: 403, projects: { error: 'forbidden' } })
    await waitFor(() => expect(screen.getByLabelText('Projeto')).toBeTruthy())
  })
})
