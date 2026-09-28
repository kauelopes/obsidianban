import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { KanbanClient } from '../api/client.js'
import { Help } from '../help/Help.js'
import { ThemeToggle, useTheme } from '../ui/theme.js'
import { SkillsPanel } from './SkillsPanel.js'
import { ModulesPanel } from './ModulesPanel.js'

const TABS = [
  { key: 'aparencia', label: 'Aparência' },
  { key: 'skills', label: 'Skills' },
  { key: 'modulos', label: 'Módulos' },
  { key: 'ajuda', label: 'Ajuda' },
] as const
type TabKey = (typeof TABS)[number]['key']

export function Configs({ client }: { client: KanbanClient }) {
  // ?secao= abre direto numa aba — o link "ativar módulo" cai em Módulos.
  const [params] = useSearchParams()
  const initial = TABS.find((t) => t.key === params.get('secao'))?.key ?? 'aparencia'
  const [activeTab, setActiveTab] = useState<TabKey>(initial)
  const { pref, cycle } = useTheme()

  return (
    <div className="detail">
      <div className="detail-inner wide">
        <div className="detail-head">
          <h1>Configurações</h1>
          <div className="detail-ident">
            <span>preferências e informações que valem para o projeto todo</span>
          </div>
        </div>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Seções de configurações">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={activeTab === t.key ? 'active' : undefined}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {activeTab === 'aparencia' && (
              <div className="detail-head">
                <h1>Aparência</h1>
                <div className="detail-ident">
                  <span>tema da interface — segue o sistema por padrão</span>
                </div>
                <ThemeToggle pref={pref} cycle={cycle} />
              </div>
            )}
            {activeTab === 'skills' && (
              <div className="detail-head">
                <h1>Skills</h1>
                <div className="detail-ident">
                  <span>fonte única dos agentes — replicada para cada projeto pelo workflow</span>
                </div>
                <SkillsPanel client={client} />
              </div>
            )}
            {activeTab === 'modulos' && (
              <div className="detail-head">
                <h1>Módulos</h1>
                <div className="detail-ident">
                  <span>funcionalidades opcionais — ative o que quiser usar; desativar não apaga dados</span>
                </div>
                <ModulesPanel client={client} />
              </div>
            )}
            {activeTab === 'ajuda' && <Help />}
          </div>
        </div>
      </div>
    </div>
  )
}
