import { useState } from 'react'
import type { KanbanClient } from '../api/client.js'
import { useModules } from '../modules/ModulesContext.js'
import { INSTALLED_WEB_MODULES } from '../modules/registry.js'

/**
 * Liga/desliga módulos opcionais. Instalar é código (registry no servidor e no
 * web); aqui só se decide o que está no ar. Só manager altera — o servidor
 * recusa os demais e o erro aparece inline.
 */
export function ModulesPanel({ client }: { client: KanbanClient }) {
  const { modules, active, loading, error, reload } = useModules()
  const [busy, setBusy] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  async function toggle(id: string, enabled: boolean) {
    setBusy(id)
    setActionError(null)
    const res = await client.updateModule(id, { enabled })
    setBusy(null)
    if (!res.ok) {
      setActionError(res.error.message)
      return
    }
    await reload()
  }

  if (loading) return <p className="empty">carregando módulos…</p>
  if (error) return <p className="banner">{error}</p>
  if (modules.length === 0) return <p className="empty">nenhum módulo instalado neste servidor</p>

  return (
    <div className="modules-panel">
      {actionError && <p className="banner">{actionError}</p>}
      <ul className="modules-list">
        {modules.map((m) => {
          const hasWeb = INSTALLED_WEB_MODULES.some((w) => w.id === m.id)
          const settings = active.find((a) => a.info.id === m.id)
          const Panel = settings?.web.settingsPanel
          return (
            <li key={m.id} className="module-row">
              <div className="module-head">
                <label className="module-toggle">
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    disabled={busy === m.id}
                    onChange={(e) => void toggle(m.id, e.target.checked)}
                    aria-label={`${m.enabled ? 'Desativar' : 'Ativar'} ${m.name}`}
                  />
                  <strong>{m.name}</strong>
                </label>
                <span className="module-version">v{m.version}</span>
                <span className={`pill ${m.enabled && !m.load_error ? 'active' : 'closed'}`}>
                  {m.load_error ? 'com erro' : m.enabled ? 'ativo' : 'desativado'}
                </span>
              </div>
              <p className="module-desc">{m.description}</p>
              {m.load_error && (
                <p className="banner">falhou ao carregar no servidor: {m.load_error}</p>
              )}
              {!hasWeb && (
                <p className="empty">sem interface web instalada — só a parte do servidor</p>
              )}
              {Panel && settings && <Panel host={settings.host} />}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
