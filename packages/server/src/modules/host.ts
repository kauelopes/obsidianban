import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  HttpMethod,
  LlmProvider,
  ModuleContext,
  ModuleDataApi,
  RouteAuth,
  RouteHandler,
  ServerModule,
} from '@obsidiankan/module-sdk'
import type { ModuleInfo, SSEEvent } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { logger } from '../util/logger.js'
import { MODULE_ID_RE } from '../util/constants.js'
import type { ModuleSettingsStore } from './settings-store.js'

export interface ModuleHostDeps {
  paths: Paths
  settings: ModuleSettingsStore
  sse: { emit(event: SSEEvent): void }
  data: ModuleDataApi
  /** Um provider por módulo: cada um ganha seu próprio cwd neutro. */
  llmFor: (moduleId: string, dataDir: string) => LlmProvider
  env: Readonly<Record<string, string | undefined>>
}

export interface ModuleRoute {
  method: HttpMethod
  pattern: string
  segments: string[]
  auth: RouteAuth
  handler: RouteHandler
}

interface LoadedModule {
  module: ServerModule
  routes: ModuleRoute[]
  loadError: string | null
}

export type RouteMatch =
  | { kind: 'ok'; route: ModuleRoute; params: Record<string, string> }
  | { kind: 'not_found' }
  | { kind: 'method_not_allowed'; allow: HttpMethod[] }

export function modulesDataRoot(paths: Paths): string {
  return path.join(paths.kanbanInternal, 'modules')
}

/**
 * Carrega os módulos instalados e guarda as rotas de cada um. Todo módulo do
 * registry passa pelo register() no boot, ativo ou não — ligar/desligar é só
 * o gate `isActive` consultado a cada requisição, sem restart. Um register()
 * que lança não derruba o servidor: o módulo fica marcado com load_error.
 */
export class ModuleHost {
  private readonly loaded = new Map<string, LoadedModule>()

  constructor(private readonly deps: ModuleHostDeps) {}

  async load(modules: readonly ServerModule[]): Promise<void> {
    for (const mod of modules) {
      if (!MODULE_ID_RE.test(mod.id)) {
        logger.error({ module: mod.id }, 'modules: id inválido — módulo ignorado')
        continue
      }
      if (this.loaded.has(mod.id)) {
        logger.error({ module: mod.id }, 'modules: id duplicado no registry — segunda cópia ignorada')
        continue
      }
      const entry: LoadedModule = { module: mod, routes: [], loadError: null }
      this.loaded.set(mod.id, entry)
      try {
        const dataDir = path.join(modulesDataRoot(this.deps.paths), mod.id)
        await fs.mkdir(dataDir, { recursive: true })
        await mod.register(this.contextFor(mod, entry, dataDir))
        logger.info(
          { module: mod.id, version: mod.version, routes: entry.routes.length, enabled: this.deps.settings.get(mod.id).enabled },
          'modules: carregado',
        )
      } catch (err) {
        entry.routes = []
        entry.loadError = err instanceof Error ? err.message : String(err)
        logger.error({ err, module: mod.id }, 'modules: register() falhou — módulo fica fora do ar')
      }
    }
  }

  list(): ModuleInfo[] {
    return [...this.loaded.values()].map((e) => this.info(e))
  }

  get(id: string): ModuleInfo | null {
    const e = this.loaded.get(id)
    return e ? this.info(e) : null
  }

  isActive(id: string): boolean {
    const e = this.loaded.get(id)
    return !!e && e.loadError === null && this.deps.settings.get(id).enabled
  }

  async update(
    id: string,
    patch: { enabled?: boolean; config?: Record<string, unknown> },
  ): Promise<ModuleInfo | null> {
    const e = this.loaded.get(id)
    if (!e) return null
    await this.deps.settings.update(id, patch)
    const info = this.info(e)
    this.deps.sse.emit({
      type: 'MODULE_EVENT',
      payload: { module: 'core', event: 'modules_changed', payload: { id, enabled: info.enabled } },
    })
    return info
  }

  /** Só consulta módulos ativos — desativado é indistinguível de inexistente. */
  match(id: string, method: string, subpath: string): RouteMatch {
    const e = this.loaded.get(id)
    if (!e || !this.isActive(id)) return { kind: 'not_found' }
    const parts = splitPath(subpath)
    const allow: HttpMethod[] = []
    for (const route of e.routes) {
      const params = matchSegments(route.segments, parts)
      if (!params) continue
      if (route.method === method) return { kind: 'ok', route, params }
      allow.push(route.method)
    }
    return allow.length > 0 ? { kind: 'method_not_allowed', allow } : { kind: 'not_found' }
  }

  private info(e: LoadedModule): ModuleInfo {
    const s = this.deps.settings.get(e.module.id)
    return {
      id: e.module.id,
      name: e.module.name,
      version: e.module.version,
      description: e.module.description,
      enabled: s.enabled,
      config: s.config,
      load_error: e.loadError,
    }
  }

  private contextFor(mod: ServerModule, entry: LoadedModule, dataDir: string): ModuleContext {
    const { settings, sse } = this.deps
    return {
      manifest: { id: mod.id, name: mod.name, version: mod.version, description: mod.description },
      logger: logger.child({ module: mod.id }),
      dataDir,
      settings: () => settings.get(mod.id),
      data: this.deps.data,
      llm: this.deps.llmFor(mod.id, dataDir),
      env: this.deps.env,
      routes: {
        register(method, pattern, auth, handler) {
          const segments = splitPath(pattern)
          const clash = entry.routes.find(
            (r) => r.method === method && r.segments.join('/') === segments.join('/'),
          )
          if (clash) throw new Error(`rota duplicada: ${method} ${pattern}`)
          entry.routes.push({ method, pattern, segments, auth, handler })
        },
      },
      events: {
        emit(event, payload) {
          sse.emit({ type: 'MODULE_EVENT', payload: { module: mod.id, event, payload } })
        },
      },
    }
  }
}

function splitPath(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0)
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
  if (pattern.length !== parts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i]!
    const part = parts[i]!
    if (seg.startsWith(':')) {
      let decoded: string
      try {
        decoded = decodeURIComponent(part)
      } catch {
        return null
      }
      params[seg.slice(1)] = decoded
    } else if (seg !== part) {
      return null
    }
  }
  return params
}
