import { useEffect, useState } from 'react'
import type { CreateAgentTokenResult, Epic, Goal, WorkflowReadinessResult } from '@obsidiankan/types'
import type { KanbanClient } from '../api/client.js'
import { errorText, type McpResult } from '../api/result.js'
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

      <section className="panel-section">
        <h3>Workflow</h3>
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
      </section>

      <section className="panel-section">
        <h3>Planejamento do projeto</h3>
        <GoalsSection client={client} project={project} onChanged={onChanged} setError={setError} />
        <EpicsSection client={client} project={project} onChanged={onChanged} setError={setError} />
      </section>

      <section className="panel-section">
        <h3>Agentes e tokens</h3>
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
      </section>

      <section className="panel-section">
        <h3>Arquivamento</h3>
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
      </section>

      <section className="panel-section panel-section--danger">
        <h3>Zona destrutiva</h3>
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
      </section>
    </Dialog>
  )
}

/**
 * Metas de médio prazo do projeto. A home só EXIBE; criar, concluir, replanejar
 * prazo e remover acontecem aqui. O estado local é a resposta das tools — o
 * resto da UI atualiza pelo SSE de PROJECT_GOALS_UPDATED via onChanged.
 */
function GoalsSection({
  client,
  project,
  onChanged,
  setError,
}: {
  client: KanbanClient
  project: string
  onChanged: () => void
  setError: (e: string | null) => void
}) {
  const [goals, setGoals] = useState<Goal[]>([])
  const [title, setTitle] = useState('')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void client.listProjects({ include_archived: true }).then((res) => {
      if (res.ok) {
        setGoals(res.data.projects.find((p) => p.project === project)?.goals ?? [])
      }
    })
  }, [client, project])

  async function mutate<T>(fn: () => Promise<McpResult<T>>): Promise<boolean> {
    setBusy(true)
    setError(null)
    const res = await fn()
    setBusy(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return false
    }
    onChanged()
    return true
  }

  async function addGoal() {
    const ok = await mutate(() =>
      client.setGoal({ project, title: title.trim(), target_date: date || null }),
    )
    if (ok) {
      setTitle('')
      setDate('')
      await reload()
    }
  }

  async function patch(id: string, changes: { status?: Goal['status']; target_date?: string | null }) {
    if (await mutate(() => client.setGoal({ project, id, ...changes }))) await reload()
  }

  async function remove(id: string) {
    if (await mutate(() => client.deleteGoal({ project, id }))) await reload()
  }

  async function reload() {
    const res = await client.listProjects({ include_archived: true })
    if (res.ok) setGoals(res.data.projects.find((p) => p.project === project)?.goals ?? [])
  }

  return (
    <div className="form">
      <p className="label">Metas do projeto</p>
      {goals.length === 0 && <p className="field-help">Nenhuma meta ainda.</p>}
      {goals.map((g) => (
        <div className="form-row goal-row" key={g.id}>
          <span className={`goal-title${g.status !== 'open' ? ' muted' : ''}`}>
            {g.status === 'done' ? '✓ ' : g.status === 'dropped' ? '× ' : ''}
            {g.title}
          </span>
          <input
            type="date"
            aria-label={`Prazo de ${g.title}`}
            value={g.target_date ?? ''}
            disabled={busy || g.status !== 'open'}
            onChange={(e) => void patch(g.id, { target_date: e.target.value || null })}
          />
          {g.status === 'open' ? (
            <button disabled={busy} onClick={() => void patch(g.id, { status: 'done' })}>
              Concluir
            </button>
          ) : (
            <button disabled={busy} onClick={() => void patch(g.id, { status: 'open' })}>
              Reabrir
            </button>
          )}
          <button className="danger" disabled={busy} onClick={() => void remove(g.id)}>
            Remover
          </button>
        </div>
      ))}
      <label>
        <span>Nova meta</span>
        <div className="form-row">
          <input
            value={title}
            placeholder="ex. Lançar a v1 pública"
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            type="date"
            aria-label="Prazo da nova meta"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <button className="primary" disabled={busy || !title.trim()} onClick={() => void addGoal()}>
            Adicionar meta
          </button>
        </div>
        <span className="field-help">
          Metas vivem no _meta.json do projeto — dá para editá-las também pelo Obsidian, e os
          agentes as enxergam via kanban_list_projects.
        </span>
      </label>
    </div>
  )
}

/**
 * Épicos do projeto — criados normalmente pelo wizard de planejamento; aqui a
 * v1 só lista e muda status (open/done/dropped). O vínculo com sprints aparece
 * como contagem; o progresso fino fica para o board.
 */
function EpicsSection({
  client,
  project,
  onChanged,
  setError,
}: {
  client: KanbanClient
  project: string
  onChanged: () => void
  setError: (e: string | null) => void
}) {
  const [epics, setEpics] = useState<Epic[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void client.listEpics(project).then((res) => {
      if (res.ok) setEpics(res.data.epics)
    })
  }, [client, project])

  if (epics.length === 0) return null

  async function setStatus(id: string, status: Epic['status']) {
    setBusy(true)
    setError(null)
    const res = await client.updateEpic({ project, id, status })
    setBusy(false)
    if (!res.ok) {
      setError(errorText(res.error))
      return
    }
    setEpics((prev) => prev.map((e) => (e.id === id ? res.data.epic : e)))
    onChanged()
  }

  return (
    <div className="form" style={{ marginTop: 'var(--s-5)' }}>
      <p className="label">Épicos</p>
      {epics.map((e) => (
        <div key={e.id} className="form-row" style={{ alignItems: 'baseline' }}>
          <span>
            <strong>{e.name}</strong>
            {e.objective && <span className="field-help"> — {e.objective}</span>}
            <span className="field-help mono"> · {e.sprint_ids.length} sprint(s)</span>
          </span>
          <div className="spacer" />
          <select
            aria-label={`status do épico ${e.name}`}
            value={e.status}
            disabled={busy}
            onChange={(ev) => void setStatus(e.id, ev.target.value as Epic['status'])}
          >
            <option value="open">aberto</option>
            <option value="done">concluído</option>
            <option value="dropped">abandonado</option>
          </select>
        </div>
      ))}
    </div>
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
