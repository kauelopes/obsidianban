import { promises as fs } from 'node:fs'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import type { Paths } from '../config.js'
import type { AuditLogger } from '../audit/logger.js'
import type { CardRepository } from '../cards/repository.js'
import type { AtomicWriter } from '../writer/atomic.js'
import type { SSEEventBus } from '../server/sse.js'
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
  if (!base.endsWith('.md')) return false
  // Skip the project metadata file (which is .json today, but guard anyway).
  if (base === '_meta.md' || base.startsWith('_')) return false
  return true
}

export class FileWatcher {
  private watcher: FSWatcher | null = null
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
    private readonly writer: AtomicWriter,
    private readonly audit: AuditLogger,
    private readonly sse: SSEEventBus,
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
    const basename = path.basename(filePath, '.md')

    let content: string
    try {
      content = await fs.readFile(filePath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }

    // Parse first so we can resolve the card by its frontmatter id, not
    // the filename (post-batch-6b the filename is derived from the title).
    let parsed
    try {
      parsed = parseCardFile(content)
    } catch {
      return  // not a card .md (user note, etc.)
    }
    const frontmatterId = parsed.data['id']
    if (typeof frontmatterId !== 'string' || !frontmatterId) {
      // Not a managed card. Could be a user-created note placed inside
      // kanban-data/. Ignore — reconciliation has no business with it.
      return
    }
    const id = frontmatterId

    const row = this.repo.findById(id)
    if (!row) {
      await this.audit.log({ op: 'EXTERNAL_MUTATION', project, card_id: id })
      return
    }

    const basenameChanged = basename !== row.file_basename
    const contentMatches = row.file_hash === sha256(content)

    // Pure user-rename (no content change): record the new basename in
    // SQLite and remove the orphan if any. No audit/SSE — neither field
    // visible to other actors changed.
    if (contentMatches && basenameChanged) {
      const card = this.repo.toCard(row)
      this.repo.update(card, row.file_hash, basename)
      const oldPath = path.join(this.paths.kanbanData, project, `${row.file_basename}.md`)
      await fs.unlink(oldPath).catch((err) => {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      })
      return
    }

    // Hash discriminator (PRD §7.4): file matches SQLite and basename
    // unchanged → our own write (or a no-op touch). Skip.
    if (contentMatches) return

    const sqliteCard = this.repo.toCard(row)

    let humanCard: Omit<Card, 'body'>
    try {
      humanCard = cardFromFrontmatter(parsed.data)
    } catch (err) {
      await this.revertWholeFile(sqliteCard, (err as Error).message)
      return
    }
    // Detect user-driven rename within the same project folder. We accept
    // it: update the basename in SQLite, keep the rest of the human-edit
    // flow. Renames across projects are treated as external mutations.
    let newBasename = row.file_basename
    if (basename !== row.file_basename) {
      newBasename = basename
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

    await this.writer.write(merged, parsed.body, newBasename, {
      previousBasename: row.file_basename,
    })
    await this.audit.log({
      op: 'HUMAN_EDIT',
      project,
      card_id: id,
      version: merged.version,
      actor: 'human:manager',
      changed_fields: diffFields(sqliteCard, merged),
    })
    this.sse.emit({
      type: 'CARD_HUMAN_EDITED',
      payload: { card_id: id, project, new_version: merged.version },
    })
  }

  private async revertWholeFile(card: Omit<Card, 'body'>, reason: string): Promise<void> {
    // file_basename always populated for cards loaded from the repo.
    const basename = card.file_basename ?? card.id
    await this.writer.write(card, '', basename)
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
