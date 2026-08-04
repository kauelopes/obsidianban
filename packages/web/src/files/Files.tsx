import { useCallback, useEffect, useState } from 'react'
import type { KadFile } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Markdown } from '../markdown/Markdown.js'

type Source = 'kad' | 'repo'

const SOURCE_LABEL: Record<Source, string> = {
  kad: 'KAD (planejamento)',
  repo: 'docs/ do repositório',
}

/**
 * Somente leitura. Duas fontes de markdown por projeto:
 * - KAD (`kad/*.md` no vault) — escrito pelo wizard de planejamento.
 * - docs/ do repositório de código (`target_repo`) — inclui a cópia de KAD
 *   que materialize.ts grava em docs/kad/, mas também qualquer outro .md que
 *   exista ali (ADRs, README de subsistema etc.).
 * Cards já têm tela própria no board; esta aba é só para os documentos de
 * apoio que hoje só dá pra ler abrindo o arquivo direto no editor/Obsidian.
 */
export function Files({ client }: { client: KanbanClient }) {
  const [projects, setProjects] = useState<string[]>([])
  // Token de dev/pm não enxerga kanban_list_projects (manager-only) — sem
  // lista, cai para um campo de texto livre, mesma postura do seletor de
  // projeto do board (App.tsx: "Token de dev não enxerga listProjects").
  const [projectsUnavailable, setProjectsUnavailable] = useState(false)
  const [project, setProject] = useState('')

  useEffect(() => {
    void client.listProjects().then((res) => {
      if (!res.ok) {
        setProjectsUnavailable(true)
        return
      }
      const names = res.data.projects.map((p) => p.project).sort()
      setProjects(names)
      setProject((prev) => prev || names[0] || '')
    })
  }, [client])

  const [kadFiles, setKadFiles] = useState<KadFile[]>([])
  const [repoFiles, setRepoFiles] = useState<KadFile[]>([])
  const [filesError, setFilesError] = useState<string | null>(null)
  const [filesLoading, setFilesLoading] = useState(false)

  const [selected, setSelected] = useState<{ source: Source; id: string } | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [contentLoading, setContentLoading] = useState(false)

  const loadFiles = useCallback(async () => {
    if (!project) return
    setFilesLoading(true)
    setSelected(null)
    setContent(null)
    const [kad, repo] = await Promise.all([client.listKadFiles(project), client.listRepoDocs(project)])
    setFilesLoading(false)
    // Um projeto sem target_repo não tem docs/ — não é erro, só lista vazia.
    // Só reporta erro de verdade se a fonte KAD (sempre disponível) falhar.
    if (!kad.ok) {
      setFilesError(errorText(kad.error))
      setKadFiles([])
      setRepoFiles([])
      return
    }
    setFilesError(null)
    setKadFiles(kad.data.files)
    setRepoFiles(repo.ok ? repo.data.files : [])
  }, [client, project])

  useEffect(() => {
    void loadFiles()
  }, [loadFiles])

  const openDoc = useCallback(
    async (source: Source, doc: KadFile) => {
      if (!project) return
      setSelected({ source, id: doc.id })
      setContentLoading(true)
      const res = source === 'kad' ? await client.getKadFile(project, doc.id) : await client.getRepoDoc(project, doc.id)
      setContentLoading(false)
      if (!res.ok) {
        setContentError(errorText(res.error))
        setContent(null)
        return
      }
      setContentError(null)
      setContent(res.data.content)
    },
    [client, project],
  )

  const sections: Array<{ source: Source; files: KadFile[] }> = [
    { source: 'kad', files: kadFiles },
    { source: 'repo', files: repoFiles },
  ]
  const noFilesAtAll = kadFiles.length === 0 && repoFiles.length === 0

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Arquivos</h1>
          <div className="detail-ident">
            {projectsUnavailable ? (
              <input
                aria-label="Projeto"
                placeholder="nome do projeto"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              />
            ) : (
              <select
                aria-label="Trocar de projeto"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>

        {filesError && <p className="banner">{filesError}</p>}

        <div className="home-grid">
          <aside className="home-side">
            {filesLoading ? (
              <p className="empty-lg">carregando documentos…</p>
            ) : noFilesAtAll ? (
              <p className="empty-lg">
                Este projeto ainda não tem documentos KAD nem docs/ no repositório vinculado.
              </p>
            ) : (
              sections.map(({ source, files }) =>
                files.length === 0 ? null : (
                  <div key={source} className="files-section">
                    <p className="label">{SOURCE_LABEL[source]}</p>
                    <ul className="pending files-list">
                      {files.map((f) => (
                        <li key={f.id}>
                          <a
                            className={
                              selected?.source === source && selected.id === f.id ? 'active' : undefined
                            }
                            onClick={() => void openDoc(source, f)}
                          >
                            {f.label}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
              )
            )}
          </aside>
          <main className="home-main">
            {contentError && <p className="banner">{contentError}</p>}
            {contentLoading ? (
              <p className="empty-lg">carregando documento…</p>
            ) : content !== null ? (
              <Markdown prose>{content}</Markdown>
            ) : (
              <p className="empty-lg">Selecione um documento.</p>
            )}
          </main>
        </div>
      </div>
    </div>
  )
}
