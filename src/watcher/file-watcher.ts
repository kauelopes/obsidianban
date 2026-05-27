import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Paths } from '../config.js'
import type { AuditLogger } from '../audit/logger.js'
import type { CardRepository } from '../cards/repository.js'
import type { AtomicWriter } from '../writer/atomic.js'
import { parseCardFile, cardFromFrontmatter } from '../cards/serialize.js'
import { loadProjectMeta } from '../vault/layout.js'
import { sha256 } from '../writer/atomic.js'
import type { Card } from '../types.js'

const DEBOUNCE_MS = 500
const IMMUTABLE_FIELDS: ReadonlyArray<keyof Omit<Card, 'body'>> = [
  'id',
  'project',
  'version',
  'position',
  'created_at',
  'created_by',
]

function isCardFile(p: string): boolean {
  const base = path.basename(p)
  return base.startsWith('card-') && base.endsWith('.md')
}

export class FileWatcher {
  private watcher: FSWatcher | null = null
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
  ) {}

  async start(): Promise<void> {
    if (this.watcher) return
    // chokidar v4 dropped glob support — watch the directory and filter inside.
    const w = chokidar.watch(this.paths.kanbanData, {
      ignoreInitial: true,
      depth: 2,
    })
    this.watcher = w
    w.on('error', (err) => console.error('[watcher] error:', err))
    w.on('add', (p) => {
      if (isCardFile(p)) this.schedule(p)
    })
    w.on('change', (p) => {
      if (isCardFile(p)) this.schedule(p)
    })
    await new Promise<void>((resolve) => w.once('ready', () => resolve()))
  }

  async stop(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    await this.watcher?.close()
    this.watcher = null
  }

  private schedule(filePath: string): void {
    const existing = this.timers.get(filePath)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.timers.delete(filePath)
      this.process(filePath).catch((err) => {
        void this.audit.log({ op: 'PARSE_ERROR', reason: (err as Error).message })
      })
    }, DEBOUNCE_MS)
    this.timers.set(filePath, timer)
  }

  private async process(filePath: string): Promise<void> {
    const project = path.basename(path.dirname(filePath))
    const id = path.basename(filePath, '.md')

    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }

    const row = this.repo.findById(id)
    if (!row) {
      // .md present without a SQLite row. Creation via markdown isn't a
      // supported flow at runtime — reconciliation at next startup will
      // import it if it's still there.
      await this.audit.log({ op: 'EXTERNAL_MUTATION', project, card_id: id })
      return
    }

    // Hash discriminator (PRD §7.4): file matches SQLite → our own write
    // (or a no-op touch). Skip.
    if (row.file_hash === sha256(content)) return

    const sqliteCard = this.repo.toCard(row)

    let parsed
    try {
      parsed = parseCardFile(content)
    } catch (err) {
      await this.revertWholeFile(sqliteCard, (err as Error).message)
      return
    }

    let humanCard: Omit<Card, 'body'>
    try {
      humanCard = cardFromFrontmatter(parsed.data)
    } catch (err) {
      await this.revertWholeFile(sqliteCard, (err as Error).message)
      return
    }

    const revertedFields: string[] = []
    const merged: Omit<Card, 'body'> = { ...humanCard }

    for (const field of IMMUTABLE_FIELDS) {
      if (humanCard[field] !== sqliteCard[field]) {
        ;(merged as Record<string, unknown>)[field] = sqliteCard[field]
        revertedFields.push(field)
      }
    }

    const meta = await loadProjectMeta(this.paths, project).catch(() => null)
    const columns = meta?.columns ?? []
    if (columns.length > 0 && !columns.includes(merged.status)) {
      merged.status = sqliteCard.status
      revertedFields.push('status')
    }
    if (merged.due_date != null && !/^\d{4}-\d{2}-\d{2}$/.test(merged.due_date)) {
      merged.due_date = sqliteCard.due_date
      revertedFields.push('due_date')
    }

    for (const field of revertedFields) {
      await this.audit.log({
        op: 'FIELD_REVERTED',
        project,
        card_id: id,
        version: sqliteCard.version,
        field,
        reason: 'human edit violated invariant or validation',
      })
    }

    merged.version = sqliteCard.version + 1
    merged.updated_at = new Date().toISOString()
    merged.updated_by = 'human:manager'

    await this.writer.write(merged, parsed.body)
    await this.audit.log({
      op: 'HUMAN_EDIT',
      project,
      card_id: id,
      version: merged.version,
      actor: 'human:manager',
      changed_fields: diffFields(sqliteCard, merged),
    })
  }

  private async revertWholeFile(card: Omit<Card, 'body'>, reason: string): Promise<void> {
    await this.writer.write(card, '')
    await this.audit.log({
      op: 'PARSE_ERROR',
      project: card.project,
      card_id: card.id,
      version: card.version,
      reason,
    })
  }
}

function diffFields(
  before: Omit<Card, 'body'>,
  after: Omit<Card, 'body'>,
): string[] {
  const out: string[] = []
  for (const k of Object.keys(after) as Array<keyof Omit<Card, 'body'>>) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) out.push(k)
  }
  return out
}
