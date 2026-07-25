import { useState } from 'react'
import type { WorkflowReadinessResult } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Dialog } from './Dialog.js'
import { Readiness } from './ProjectPanel.js'

/**
 * Criar projeto.
 *
 * `createProject` existia no cliente desde a fase 2 sem nenhum call site: dava
 * para criar projeto por curl, não pela tela. A tool minta um token de pm
 * inicial e o devolve **uma única vez** — o plugin gravava isso num arquivo do
 * vault (`_kanban-secrets/`), que é a dívida D4. Aqui ele só existe nesta tela.
 *
 * Informar o repo aqui provisiona o ambiente do workflow na mesma chamada:
 * copia as skills, escreve os configs e minta os tokens de pm e dev. Antes o
 * campo só gravava o caminho no _meta.json, e o projeto ficava com cara de
 * pronto e sem nada dentro.
 */
export function CreateProject({
  client,
  onClose,
  onCreated,
}: {
  client: KanbanClient
  onClose: () => void
  onCreated: () => void
}) {
  const [project, setProject] = useState('')
  const [actor, setActor] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [repo, setRepo] = useState('')
  const [created, setCreated] = useState<{
    project: string
    token: string
    token_id: string
    readiness: WorkflowReadinessResult | null
  } | null>(null)

  async function submit() {
    setBusy(true)
    setError(null)
    const target = repo.trim()
    const res = await client.createProject({
      project: project.trim(),
      actor: actor.trim(),
      ...(target ? { target_repo: target } : {}),
    })
    setBusy(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setCreated({
      project: res.data.project,
      token: res.data.token,
      token_id: res.data.token_id,
      readiness: res.data.workflow_readiness ?? null,
    })
    onCreated()
  }

  return (
    <Dialog title="Novo projeto" onClose={onClose}>
      {error && <p className="banner">{error}</p>}

      {created ? (
        <>
          <p className="field-help">
            Projeto <strong>{created.project}</strong> criado com as colunas padrão.
          </p>
          <p className="label" style={{ marginTop: 'var(--s-5)' }}>
            Token de pm — copie agora, não é recuperável
          </p>
          <pre style={{ margin: 'var(--s-2) 0 0' }}>
            <code>{created.token}</code>
          </pre>
          <p className="field-help" style={{ marginTop: 'var(--s-3)' }}>
            token_id <span className="mono">{created.token_id}</span>. Para gerar um token de dev,
            abra “ajustes” no projeto.
          </p>
          {created.readiness && <Readiness r={created.readiness} />}
        </>
      ) : (
        <div className="form">
          <label>
            <span>Nome do projeto</span>
            <input
              autoFocus
              className="mono"
              value={project}
              placeholder="meu-projeto"
              onChange={(e) => setProject(e.target.value)}
            />
            <span className="field-help">
              Vira o nome da pasta em <code>kanban-data/</code>.
            </span>
          </label>
          <label>
            <span>Actor do token inicial</span>
            <input
              value={actor}
              placeholder="human:kaue"
              onChange={(e) => setActor(e.target.value)}
            />
          </label>
          <label>
            <span>Repo do workflow (opcional)</span>
            <input
              className="mono"
              value={repo}
              placeholder="/home/voce/projetos/meu-repo"
              onChange={(e) => setRepo(e.target.value)}
            />
            <span className="field-help">
              Caminho absoluto. Preenchido, o servidor já instala as skills, escreve o{' '}
              <code>mcp.json</code> e gera os tokens que o sprint workflow exige. Dá para deixar
              vazio e configurar depois em “ajustes”.
            </span>
          </label>
          <div className="form-row">
            <div className="spacer" />
            <button
              className="primary"
              disabled={busy || !project.trim() || !actor.trim()}
              onClick={submit}
            >
              Criar projeto
            </button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
