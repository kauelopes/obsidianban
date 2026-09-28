import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ModuleInfo } from '@obsidiankan/types'
import type { ModuleHost, WebModule } from '@obsidiankan/module-sdk/web'
import type { KanbanClient } from '../api/client.js'
import { subscribe } from '../api/events.js'
import { Markdown } from '../markdown/Markdown.js'
import { INSTALLED_WEB_MODULES } from './registry.js'

export interface ActiveModule {
  info: ModuleInfo
  web: WebModule
  host: ModuleHost
}

export interface ModulesState {
  /** Tudo que o servidor reporta como instalado, ativo ou não. */
  modules: ModuleInfo[]
  /** Ativos no servidor, sem load_error e com parte web instalada. */
  active: ActiveModule[]
  loading: boolean
  error: string | null
  reload: () => Promise<void>
}

const EMPTY: ModulesState = {
  modules: [],
  active: [],
  loading: false,
  error: null,
  reload: async () => {},
}

const ModulesContext = createContext<ModulesState>(EMPTY)

export function useModules(): ModulesState {
  return useContext(ModulesContext)
}

export function makeModuleHost(client: KanbanClient, info: ModuleInfo): ModuleHost {
  return {
    moduleId: info.id,
    config: info.config,
    ui: { Markdown },
    api: {
      fetch: (path, init) => client.moduleFetch(info.id, path, init),
      onEvent: (handler) =>
        subscribe((ev) => {
          if (ev.type !== 'MODULE_EVENT' || ev.payload['module'] !== info.id) return
          handler(String(ev.payload['event'] ?? ''), ev.payload['payload'])
        }),
    },
  }
}

/**
 * Lista de módulos do servidor, recarregada quando alguém liga/desliga um
 * (MODULE_EVENT do core) — o menu muda na hora, em todas as abas abertas.
 */
export function ModulesProvider({
  client,
  children,
  installed = INSTALLED_WEB_MODULES,
}: {
  client: KanbanClient
  children: React.ReactNode
  installed?: readonly WebModule[]
}) {
  const [modules, setModules] = useState<ModuleInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const res = await client.listModules()
    setLoading(false)
    if (res.ok) {
      setModules(res.data.modules)
      setError(null)
    } else {
      setError(res.error.message)
    }
  }, [client])

  useEffect(() => {
    void reload()
    return subscribe((ev) => {
      if (ev.type === 'MODULE_EVENT' && ev.payload['module'] === 'core') void reload()
    })
  }, [reload])

  const active = useMemo(() => {
    const out: ActiveModule[] = []
    for (const info of modules) {
      if (!info.enabled || info.load_error) continue
      const web = installed.find((w) => w.id === info.id)
      if (web) out.push({ info, web, host: makeModuleHost(client, info) })
    }
    return out
  }, [modules, installed, client])

  const value = useMemo(
    () => ({ modules, active, loading, error, reload }),
    [modules, active, loading, error, reload],
  )
  return <ModulesContext.Provider value={value}>{children}</ModulesContext.Provider>
}
