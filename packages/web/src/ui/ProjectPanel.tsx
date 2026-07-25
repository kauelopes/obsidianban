import { useState } from 'react'
import type { CreateAgentTokenResult, WorkflowReadinessResult } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText } from '../api/result.js'
import { Dialog } from './Dialog.js'

/**
 * Ajustes do projeto — o único lugar da UI para as quatro tools de admin de
 * projeto e para mintar tokens de agente.
 *
 * Definir o repo não é só gravar um caminho: o servidor instala as skills,
 * escreve os configs e minta os tokens de pm/dev que faltarem, devolvendo tudo
 * em `workflow_readiness`. Então este painel é, na prática, o checklist de
 * prontidão do sprint workflow — e a via pela qual se obtém um token dev de
 * verdade, que o CLI não sabe gerar.
 */
export function ProjectPanel({
  client,
  project,
  onClose,
  onChanged,
}: {
  client: KanbanClient
  project: string
  onClose: () => void
  onChanged: () => void
}) {
  const [repo, setRepo] = useState('')
  const [readiness, setReadiness] = useState<WorkflowReadinessResult | null>(null)
  const [actor, setActor] = useState('')
  const [agentType, setAgentType] = useState<'pm' | 'dev'>('dev')
  const [minted, setMinted] = useState<CreateAgentTokenResult | null>(null)
  const [confirmText, setConfirmText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  async function setRepoPath(target: string | null) {
    setBusy(true)
    setError(null)
    const res = await client.setProjectRepo({ project, target_repo: target })
    setBusy(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setReadiness(res.data.workflow_readiness ?? null)
    setNote(target === null ? 'Repositório removido.' : 'Repositório definido.')
    onChanged()
  }

  async function mint() {
    setBusy(true)
    setError(null)
    const res = await client.createAgentToken({
      project,
      actor: actor.trim(),
      agent_type: agentType,
    })
    setBusy(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setMinted(res.data)
    setActor('')
  }

  async function removeProject() {
    setBusy(true)
    setError(null)
    const res = await client.deleteProject({ project, confirm: confirmText })
    setBusy(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    onChanged()
    onClose()
  }

  return (
    <Dialog title={`Ajustes — ${project}`} onClose={onClose}>
      {error && <p className="banner">{error}</p>}
      {note && <p className="field-help">{note}</p>}

      <div className="form">
        <label>
          <span>Repositório do workflow</span>
          <input
            className="mono"
            value={repo}
            placeholder="/caminho/absoluto/para/o/repo"
            onChange={(e) => setRepo(e.target.value)}
          />
          <span className="field-help">
            É o diretório de trabalho do sprint workflow. Ao definir, o servidor instala as
            skills, escreve os configs e gera os tokens de pm e dev que faltarem — eles
            aparecem abaixo uma única vez.
          </span>
        </label>
        <div className="form-row">
          <button
            className="primary"
            disabled={busy || !repo.trim()}
            onClick={() => setRepoPath(repo.trim())}
          >
            Definir repositório
          </button>
          <button disabled={busy} onClick={() => setRepoPath(null)}>
            Remover repositório
          </button>
        </div>
      </div>

      {readiness && <Readiness r={readiness} />}

      <hr style={{ border: 'none', borderTop: '1px solid var(--rule)', margin: 'var(--s-6) 0' }} />

      <div className="form">
        <label>
          <span>Novo token de agente</span>
          <div className="form-row">
            <input
              value={actor}
              placeholder="actor (ex. dev-claude)"
              onChange={(e) => setActor(e.target.value)}
            />
            <select
              aria-label="Tipo de agente"
              value={agentType}
              onChange={(e) => setAgentType(e.target.value === 'pm' ? 'pm' : 'dev')}
            >
              <option value="dev">dev — só log</option>
              <option value="pm">pm — acesso completo</option>
            </select>
            <button disabled={busy || !actor.trim()} onClick={mint}>
              Gerar token
            </button>
          </div>
          <span className="field-help">
            O CLI <code>kanban-token</code> grava sempre <code>agent_type: pm</code>; esta é a
            única via para um token dev de verdade.
          </span>
        </label>
      </div>

      {minted && <TokenOnce t={minted} />}

      <hr style={{ border: 'none', borderTop: '1px solid var(--rule)', margin: 'var(--s-6) 0' }} />

      <div className="form">
        <div className="form-row">
          <button disabled={busy} onClick={() => void client.archiveProject({ project }).then(onChanged)}>
            Arquivar projeto
          </button>
          <button
            disabled={busy}
            onClick={() => void client.unarchiveProject({ project }).then(onChanged)}
          >
            Desarquivar
          </button>
        </div>
        <label>
          <span>Deletar projeto — permanente</span>
          <div className="form-row">
            <input
              className="mono"
              value={confirmText}
              placeholder={`digite “${project}” para confirmar`}
              onChange={(e) => setConfirmText(e.target.value)}
            />
            <button className="danger" disabled={busy || confirmText !== project} onClick={removeProject}>
              Deletar
            </button>
          </div>
          <span className="field-help">
            Apaga a pasta do projeto e todos os seus cards. Não há desfazer.
          </span>
        </label>
      </div>
    </Dialog>
  )
}

/**
 * Checklist de prontidão. Exportado porque a criação de projeto com repo passa
 * pelo mesmo provisionamento e deve mostrar o mesmo relatório — inclusive os
 * tokens, que só existem naquele instante.
 */
export function Readiness({ r }: { r: WorkflowReadinessResult }) {
  const pending = [
    ...r.skills.filter((s) => !s.was_present && !s.installed).map((s) => s.path),
    ...r.config_files.filter((c) => !c.was_present && !c.written).map((c) => c.path),
  ]
  return (
    <section style={{ marginTop: 'var(--s-6)' }}>
      <p className="label">Prontidão do workflow</p>
      <dl className="managed" style={{ borderTop: 'none', paddingTop: 0 }}>
        <div style={{ display: 'contents' }}>
          <dt>repo</dt>
          <dd>{r.target_repo}</dd>
          <dt>existe</dt>
          <dd>{r.repo_exists ? 'sim' : 'não'}</dd>
          <dt>skills</dt>
          <dd>
            {r.skills.filter((s) => s.was_present || s.installed).length}/{r.skills.length}
          </dd>
          <dt>configs</dt>
          <dd>
            {r.config_files.filter((c) => c.was_present || c.written).length}/
            {r.config_files.length}
          </dd>
          <dt>token pm</dt>
          <dd>{r.tokens.has_pm || r.tokens.generated_pm ? 'ok' : 'faltando'}</dd>
          <dt>token dev</dt>
          <dd>{r.tokens.has_dev || r.tokens.generated_dev ? 'ok' : 'faltando'}</dd>
        </div>
      </dl>

      {!r.repo_exists && (
        <p className="field-help" style={{ color: 'var(--alert)', marginTop: 'var(--s-4)' }}>
          O caminho não existe no disco. O workflow não vai subir até ele existir.
        </p>
      )}
      {pending.length > 0 && (
        <p className="field-help" style={{ marginTop: 'var(--s-4)' }}>
          Não instalado: <span className="mono">{pending.join(', ')}</span>
        </p>
      )}

      {/*
        Os dois tokens abaixo aparecem uma vez e não são recuperáveis. São
        exatamente os valores de KANBAN_PM_TOKEN e KANBAN_DEV_TOKEN que o sprint
        workflow exige — sem eles ele encerra com exit 2.
      */}
      {r.tokens.generated_pm && (
        <EnvLine name="KANBAN_PM_TOKEN" value={r.tokens.generated_pm.token} />
      )}
      {r.tokens.generated_dev && (
        <EnvLine name="KANBAN_DEV_TOKEN" value={r.tokens.generated_dev.token} />
      )}
    </section>
  )
}

function EnvLine({ name, value }: { name: string; value: string }) {
  return (
    <div style={{ marginTop: 'var(--s-4)' }}>
      <p className="label">{name} — copie agora, não é recuperável</p>
      <pre style={{ margin: 'var(--s-2) 0 0' }}>
        <code>
          {name}={value}
        </code>
      </pre>
    </div>
  )
}

function TokenOnce({ t }: { t: CreateAgentTokenResult }) {
  return (
    <section style={{ marginTop: 'var(--s-5)' }}>
      <p className="label">
        Token de {t.agent_type} para {t.actor} — copie agora, não é recuperável
      </p>
      <pre style={{ margin: 'var(--s-2) 0 0' }}>
        <code>{t.token}</code>
      </pre>
      <p className="field-help" style={{ marginTop: 'var(--s-3)' }}>
        token_id <span className="mono">{t.token_id}</span>. O plugin gravava isto em arquivo no
        vault; aqui ele só existe nesta tela.
      </p>
    </section>
  )
}
