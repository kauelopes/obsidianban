// Contrato web dos módulos — consumido como fonte pelo Vite do @obsidiankan/web
// (sem build próprio). O módulo nunca importa código do web: tudo que ele usa
// do core chega pelo `ModuleHost`.

import type { ComponentType, ReactNode } from 'react'

export interface ModuleWebApi {
  /** fetch em /modules/<id><path>, com o bearer da sessão já anexado. */
  fetch(path: string, init?: RequestInit): Promise<Response>
  /** Assina eventos `MODULE_EVENT` deste módulo; devolve o unsubscribe. */
  onEvent(handler: (event: string, payload: unknown) => void): () => void
}

/**
 * Componentes do core que o módulo reusa para ficar com a mesma cara do resto
 * da interface. As classes CSS globais do core (detail, home-grid, banner,
 * empty-lg, label, field-help, pill, button.primary…) e os tokens (--s-*,
 * --fg-*, --ink-*, --rule, --accent) também fazem parte do contrato.
 */
export interface ModuleHostUi {
  /** Renderizador Markdown do core (GFM, math, mermaid). */
  Markdown: ComponentType<{ children: string; prose?: boolean }>
  /** Modal do core: overlay, foco preso, Esc fecha. */
  Dialog: ComponentType<{ title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }>
}

export interface ModuleHost {
  moduleId: string
  api: ModuleWebApi
  ui: ModuleHostUi
  /** config do modules.json, como o servidor devolveu. */
  config: Record<string, unknown>
  /** Grava a config do módulo (só manager). Recarrega a lista de módulos. */
  saveConfig(config: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }>
}

export interface ModulePageProps {
  host: ModuleHost
}

export interface ModuleProjectTabProps {
  host: ModuleHost
  project: string
}

export interface WebModule {
  /** Mesmo id do ServerModule. */
  id: string
  /** Página global em /m/<id> com item no menu principal. */
  page?: { navLabel: string; component: ComponentType<ModulePageProps> }
  /** Aba no workspace do projeto em /board/<project>/m/<id>. */
  projectTab?: { label: string; component: ComponentType<ModuleProjectTabProps> }
  /** Painel extra em Configs → Módulos, abaixo do toggle. */
  settingsPanel?: ComponentType<ModulePageProps>
}
