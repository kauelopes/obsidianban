import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import type { ModuleSettings } from '@obsidiankan/module-sdk'
import { logger } from '../util/logger.js'

type SettingsFile = Record<string, { enabled?: unknown; config?: unknown }>

/**
 * `.kanban/modules.json` — estado de ativação e config de cada módulo. Arquivo
 * único (é pouca coisa, lida inteira no boot), mantido em memória e regravado
 * atomicamente a cada mudança. Módulo sem entrada nasce desativado: instalar
 * não pode ligar nada sozinho.
 */
export class ModuleSettingsStore {
  private data: Record<string, ModuleSettings> = {}
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, file: this.file }, 'modules: falha ao ler modules.json — todos desativados')
      }
      return
    }
    try {
      const parsed = JSON.parse(raw) as SettingsFile
      for (const [id, entry] of Object.entries(parsed)) {
        this.data[id] = {
          enabled: entry.enabled === true,
          config: isRecord(entry.config) ? entry.config : {},
        }
      }
    } catch (err) {
      logger.warn({ err, file: this.file }, 'modules: modules.json inválido — todos desativados')
    }
  }

  get(id: string): ModuleSettings {
    const s = this.data[id]
    return s ? { enabled: s.enabled, config: { ...s.config } } : { enabled: false, config: {} }
  }

  async update(id: string, patch: { enabled?: boolean; config?: Record<string, unknown> }): Promise<ModuleSettings> {
    const current = this.get(id)
    const next: ModuleSettings = {
      enabled: patch.enabled ?? current.enabled,
      config: patch.config ?? current.config,
    }
    this.data[id] = next
    // Serializa as gravações: dois toggles seguidos não podem terminar com o
    // arquivo do primeiro por cima do segundo.
    this.writing = this.writing.then(() => this.persist())
    await this.writing
    return this.get(id)
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, this.file)
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
