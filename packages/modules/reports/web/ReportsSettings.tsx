import { useState } from 'react'
import type { ModulePageProps } from '@obsidiankan/module-sdk/web'

const FIELDS = [
  { key: 'brand', label: 'Marca', help: 'Nome na capa e no cabeçalho do PDF. Padrão: ObsidianKan.' },
  { key: 'tagline', label: 'Linha de apoio', help: 'Aparece sob a marca na capa.' },
  { key: 'document_type', label: 'Tipo de documento', help: 'Rótulo no canto da capa. Padrão: Relatório de projeto.' },
  { key: 'footer', label: 'Rodapé das páginas', help: 'Texto no pé de cada página do PDF.' },
  { key: 'site', label: 'Site', help: 'Opcional — vai na linha de metadados da capa.' },
] as const

/** Tema do PDF: textos da marca. Layout, fontes e cores vêm do renderer. */
export function ReportsSettings({ host }: ModulePageProps) {
  const initial = (host.config['theme'] ?? {}) as Record<string, string>
  const [theme, setTheme] = useState<Record<string, string>>(initial)
  const [state, setState] = useState<{ busy: boolean; msg: string | null; error: boolean }>({ busy: false, msg: null, error: false })

  async function save() {
    setState({ busy: true, msg: null, error: false })
    const clean = Object.fromEntries(Object.entries(theme).filter(([, v]) => v.trim()))
    const res = await host.saveConfig({ ...host.config, theme: clean })
    setState(res.ok ? { busy: false, msg: 'salvo', error: false } : { busy: false, msg: res.error, error: true })
  }

  return (
    <div className="reports-settings">
      <p className="label">Identidade do PDF</p>
      {FIELDS.map((f) => (
        <label key={f.key} className="reports-field">
          <span>{f.label}</span>
          <input value={theme[f.key] ?? ''} onChange={(e) => setTheme({ ...theme, [f.key]: e.target.value })} aria-label={f.label} />
          <span className="field-help">{f.help}</span>
        </label>
      ))}
      <div className="report-toolbar">
        <button type="button" className="primary" disabled={state.busy} onClick={() => void save()}>
          salvar identidade
        </button>
        {state.msg && <span className={state.error ? 'reports-warn' : 'field-help'}>{state.msg}</span>}
      </div>
    </div>
  )
}
