import { ItemView, Notice, TFile, type WorkspaceLeaf } from 'obsidian'
import type KanbanPlugin from '../main.js'
import type {
  CardSummary,
  CardCreatedPayload,
  CardDeletedPayload,
  CardMovedPayload,
  CardReorderedPayload,
  CardUpdatedPayload,
  CardHumanEditedPayload,
} from '../../../src/types.js'
import type { McpError } from '../mcp/client.js'
import type { SSEFrame, SseStatus } from '../mcp/sse-subscriber.js'
import { ConflictModal } from '../ui/conflict-modal.js'
import { CreateCardModal } from '../ui/create-card-modal.js'
import { showErrorToast, showRetryToast } from '../ui/toast.js'
import { appendCard, patchCard, removeCard, replaceCard } from './state.js'
import { DEFAULT_COLUMN_ORDER, renderBoard, todayString } from './render.js'

export const VIEW_TYPE_KANBAN_BOARD = 'kanban-mcp-board'

/** Magic position used during the optimistic window — far past any real
 *  card position so the moved/created card lands at the bottom of the
 *  target column until the server response replaces it. */
const OPTIMISTIC_POSITION = Number.MAX_SAFE_INTEGER

export class KanbanBoardView extends ItemView {
  private cards: CardSummary[] = []
  private projectShapes: Array<{ project: string; columns: readonly string[] }> = []

  constructor(leaf: WorkspaceLeaf, private readonly plugin: KanbanPlugin) {
    super(leaf)
  }

  override getViewType(): string {
    return VIEW_TYPE_KANBAN_BOARD
  }

  override getDisplayText(): string {
    return 'Kanban'
  }

  override getIcon(): string {
    return 'kanban-square'
  }

  override async onOpen(): Promise<void> {
    this.contentEl.addClass('kanban-mcp-board')
    this.registerDomEvent(this.contentEl, 'dragstart', this.onDragStart)
    this.registerDomEvent(this.contentEl, 'dragover', this.onDragOver)
    this.registerDomEvent(this.contentEl, 'dragleave', this.onDragLeave)
    this.registerDomEvent(this.contentEl, 'drop', this.onDrop)
    this.registerDomEvent(this.contentEl, 'click', this.onClick)
    this.registerDomEvent(this.contentEl, 'keydown', this.onKeyDown)
    await this.refresh()
  }

  override async onClose(): Promise<void> {
    this.contentEl.empty()
  }

  async refresh(): Promise<void> {
    const client = this.plugin.client
    if (!client) {
      this.renderError('Plugin not initialized')
      return
    }
    // Fetch cards and projects in parallel; the project list is what keeps
    // empty boards visible (with columns + "+ Add card"), so we render even
    // if it returns zero — the empty-state message tells the user how to
    // create one.
    const [cardsResult, projectsResult] = await Promise.all([
      client.listCards({ include_archived: this.plugin.settings.showArchived }),
      client.listProjects(),
    ])
    if (!cardsResult.ok) {
      this.renderError(`MCP ${cardsResult.error.kind}: ${cardsResult.error.message}`)
      return
    }
    this.cards = [...cardsResult.data.cards]
    this.projectShapes = projectsResult.ok ? [...projectsResult.data.projects] : []
    this.render()
  }

  private render(): void {
    this.contentEl.empty()
    if (this.plugin.connectionStatus !== 'connected') {
      this.renderOfflineBanner(this.plugin.connectionStatus)
    }
    const shapes = [...this.projectShapes]
    // Surface the settings.projectName as a pseudo-project too so users can
    // see a placeholder column layout before any first card is created and
    // before the server learns about the project.
    const settingsProject = this.plugin.settings.projectName
    if (settingsProject && !shapes.some((s) => s.project === settingsProject)) {
      shapes.push({ project: settingsProject, columns: DEFAULT_COLUMN_ORDER })
    }
    renderBoard(this.contentEl, this.cards, todayString(), shapes)
  }

  private renderOfflineBanner(status: SseStatus): void {
    const banner = this.contentEl.createDiv({ cls: 'kanban-mcp-offline-banner' })
    banner.setText(
      status === 'connecting'
        ? 'Connecting to MCP…'
        : 'MCP is unreachable. The board is read-only until the connection is restored.',
    )
  }

  onConnectionStatusChange(_status: SseStatus): void {
    // Repaint to show/hide the offline banner. Don't re-fetch — that would
    // hammer the server while it's still down.
    this.render()
  }

  private renderError(msg: string): void {
    this.contentEl.empty()
    this.contentEl.createDiv({ cls: 'kanban-mcp-error', text: msg })
  }

  // ── Drag & drop ────────────────────────────────────────────────────────

  private readonly onDragStart = (e: DragEvent): void => {
    const cardEl = closestEl(e.target, '.kanban-mcp-card')
    if (!cardEl || !e.dataTransfer) return
    const cardId = cardEl.dataset['cardId']
    if (!cardId) return
    e.dataTransfer.setData('text/x-kanban-mcp', cardId)
    e.dataTransfer.effectAllowed = 'move'
    cardEl.addClass('kanban-mcp-card-dragging')
  }

  private readonly onDragOver = (e: DragEvent): void => {
    const colEl = columnFromTarget(e.target)
    if (!colEl) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    colEl.addClass('kanban-mcp-column-dragover')
  }

  private readonly onDragLeave = (e: DragEvent): void => {
    const colEl = columnFromTarget(e.target)
    if (!colEl) return
    // dragleave fires on every child boundary; only drop the highlight when
    // we actually leave the column.
    if (e.relatedTarget instanceof HTMLElement && colEl.contains(e.relatedTarget)) return
    colEl.removeClass('kanban-mcp-column-dragover')
  }

  private readonly onDrop = (e: DragEvent): void => {
    const colEl = columnFromTarget(e.target)
    if (!colEl) return
    e.preventDefault()
    colEl.removeClass('kanban-mcp-column-dragover')
    this.contentEl
      .querySelectorAll('.kanban-mcp-card-dragging')
      .forEach((el) => el.removeClass('kanban-mcp-card-dragging'))
    const cardId = e.dataTransfer?.getData('text/x-kanban-mcp')
    if (!cardId) return
    const targetProject = colEl.dataset['project']
    const targetStatus = colEl.dataset['status']
    if (!targetProject || !targetStatus) return
    void this.attemptMove(cardId, targetProject, targetStatus)
  }

  // ── SSE event mapping ──────────────────────────────────────────────────

  async handleSseEvent(frame: SSEFrame): Promise<void> {
    switch (frame.type) {
      case 'CARD_CREATED':
      case 'CARD_UPDATED':
      case 'CARD_HUMAN_EDITED':
        await this.refetchCard(
          (frame.data as CardCreatedPayload | CardUpdatedPayload | CardHumanEditedPayload).card_id,
        )
        return
      case 'CARD_MOVED': {
        const p = frame.data as CardMovedPayload
        this.cards = patchCard(this.cards, p.card_id, {
          status: p.to_status,
          position: p.new_position,
        })
        this.render()
        return
      }
      case 'CARD_REORDERED': {
        const p = frame.data as CardReorderedPayload
        let next = this.cards
        for (const a of p.affected_cards) {
          next = patchCard(next, a.id, { position: a.new_position })
        }
        this.cards = next
        this.render()
        return
      }
      case 'CARD_DELETED': {
        const p = frame.data as CardDeletedPayload
        this.cards = removeCard(this.cards, p.card_id)
        this.render()
        return
      }
      case 'CARD_ARCHIVED':
      case 'CARD_UNARCHIVED': {
        // Server emits only {card_id, project}; the visibility decision
        // depends on the showArchived setting. Refetch the card and either
        // patch the list (if it should stay) or drop it.
        const p = frame.data as { card_id: string }
        await this.reconcileArchivedCard(p.card_id)
        return
      }
    }
  }

  private async reconcileArchivedCard(cardId: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const res = await client.getCard(cardId)
    if (!res.ok) {
      // If we can no longer see it (e.g. archived + showArchived=false would
      // not gate getCard, but cross-project 404 might), just drop it.
      this.cards = removeCard(this.cards, cardId)
      this.render()
      return
    }
    const card = res.data
    const keep = this.plugin.settings.showArchived || !card.archived
    const exists = this.cards.some((c) => c.id === cardId)
    if (!keep) {
      this.cards = removeCard(this.cards, cardId)
    } else if (exists) {
      this.cards = replaceCard(this.cards, card)
    } else {
      this.cards = appendCard(this.cards, card)
    }
    this.render()
  }

  private async refetchCard(cardId: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const res = await client.getCard(cardId)
    if (!res.ok) return
    const exists = this.cards.some((c) => c.id === cardId)
    this.cards = exists ? replaceCard(this.cards, res.data) : appendCard(this.cards, res.data)
    this.render()
  }

  private readonly onClick = (e: MouseEvent): void => {
    const addBtn = closestEl(e.target, '.kanban-mcp-column-add')
    if (addBtn) {
      const project = addBtn.dataset['project']
      const status = addBtn.dataset['status']
      if (project && status) this.promptCreate(project, status)
      return
    }
    // Card-level action buttons must short-circuit before the card-open
    // fallback below, otherwise the .md file would open every time the user
    // clicks archive / restore.
    const archiveBtn = closestEl(e.target, '.kanban-mcp-card-archive')
    if (archiveBtn) {
      e.stopPropagation()
      const cardId = archiveBtn.dataset['cardId']
      if (cardId) void this.attemptArchive(cardId)
      return
    }
    const unarchiveBtn = closestEl(e.target, '.kanban-mcp-card-unarchive')
    if (unarchiveBtn) {
      e.stopPropagation()
      const cardId = unarchiveBtn.dataset['cardId']
      if (cardId) void this.attemptUnarchive(cardId)
      return
    }
    const cardEl = closestEl(e.target, '.kanban-mcp-card')
    if (cardEl) {
      const cardId = cardEl.dataset['cardId']
      if (cardId) void this.openCardFile(cardId)
      return
    }
  }

  /** Enter/Space on a focused card → open the .md (keyboard equivalent of
   *  the click handler). Drag uses pointer events; no keyboard alternative
   *  for moving cards in this batch. */
  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const cardEl = closestEl(e.target, '.kanban-mcp-card')
    if (!cardEl) return
    e.preventDefault()
    const cardId = cardEl.dataset['cardId']
    if (cardId) void this.openCardFile(cardId)
  }

  private async openCardFile(cardId: string): Promise<void> {
    const card = this.cards.find((c) => c.id === cardId)
    if (!card) return
    // Filenames are title-derived since batch 6b; fall back to id for
    // older API responses that don't populate file_basename.
    const basename = card.file_basename ?? cardId
    const path = `kanban-data/${card.project}/${basename}.md`
    const file = this.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file)
      return
    }
    showErrorToast(`Card file not found: ${path}`)
  }

  // ── Mutations ──────────────────────────────────────────────────────────

  private async attemptMove(cardId: string, targetProject: string, targetStatus: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const original = this.cards.find((c) => c.id === cardId)
    if (!original) return
    if (original.status === targetStatus && original.project === targetProject) return
    if (original.project !== targetProject) {
      new Notice('Cannot move card across projects')
      return
    }

    const snapshot = this.cards
    this.cards = patchCard(this.cards, cardId, {
      status: targetStatus,
      position: OPTIMISTIC_POSITION,
    })
    this.render()

    const result = await client.moveCard({
      id: cardId,
      version: original.version,
      to_status: targetStatus,
      input_tokens: 0,
      output_tokens: 0,
      model: 'plugin',
    })
    if (result.ok) {
      this.cards = replaceCard(this.cards, result.data)
      this.render()
      return
    }
    this.cards = [...snapshot]
    this.render()
    this.handleMutationError(result.error, 'Move failed', () =>
      this.retryMove(cardId, targetProject, targetStatus, result.error),
    )
  }

  /** Re-issue a move using the server's current_version (from 409 payload). */
  private async retryMove(
    cardId: string,
    targetProject: string,
    targetStatus: string,
    error: McpError,
  ): Promise<void> {
    if (error.kind !== 'conflict') {
      void this.attemptMove(cardId, targetProject, targetStatus)
      return
    }
    const client = this.plugin.client
    if (!client) return
    const result = await client.moveCard({
      id: cardId,
      version: error.currentVersion,
      to_status: targetStatus,
      input_tokens: 0,
      output_tokens: 0,
      model: 'plugin',
    })
    if (result.ok) {
      this.cards = replaceCard(this.cards, result.data)
      this.render()
    } else {
      this.handleMutationError(result.error, 'Move retry failed', () =>
        this.retryMove(cardId, targetProject, targetStatus, result.error),
      )
    }
  }

  private promptCreate(project: string, status: string): void {
    new CreateCardModal(this.app, async (title) => {
      await this.attemptCreate(project, status, title)
    }).open()
  }

  private async attemptCreate(project: string, status: string, title: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return

    const now = new Date().toISOString()
    const tempId = `card-optimistic-${Date.now()}`
    const placeholder: CardSummary = {
      id: tempId,
      project,
      title,
      status,
      type: 'task',
      version: 0,
      position: OPTIMISTIC_POSITION,
      priority: 'medium',
      tags: [],
      due_date: null,
      assigned_to: null,
      owner: null,
      agent_notes: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      archived: false,
      created_at: now,
      updated_at: now,
      created_by: 'human:plugin',
      updated_by: 'human:plugin',
    }
    const snapshot = this.cards
    this.cards = appendCard(this.cards, placeholder)
    this.render()

    const result = await client.createCard({
      title,
      type: 'task',
      project,
      status,
      input_tokens: 0,
      output_tokens: 0,
      model: 'plugin',
    })
    if (result.ok) {
      this.cards = replaceCard(removeCard(this.cards, tempId), result.data)
      this.render()
      return
    }
    this.cards = [...snapshot]
    this.render()
    this.handleMutationError(result.error, 'Create failed', () =>
      this.attemptCreate(project, status, title),
    )
  }

  private async attemptArchive(cardId: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const card = this.cards.find((c) => c.id === cardId)
    if (!card) return
    const result = await client.archiveCard({
      id: cardId,
      version: card.version,
      input_tokens: 0,
      output_tokens: 0,
      model: 'plugin',
    })
    if (result.ok) {
      // SSE will broadcast CARD_ARCHIVED and reconcileArchivedCard handles
      // the visibility decision — but apply immediately so the UI doesn't
      // flicker waiting on the round trip.
      if (this.plugin.settings.showArchived) {
        this.cards = replaceCard(this.cards, result.data)
      } else {
        this.cards = removeCard(this.cards, cardId)
      }
      this.render()
      return
    }
    this.handleMutationError(result.error, 'Archive failed', () => this.attemptArchive(cardId))
  }

  private async attemptUnarchive(cardId: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const card = this.cards.find((c) => c.id === cardId)
    if (!card) return
    const result = await client.unarchiveCard({
      id: cardId,
      version: card.version,
      input_tokens: 0,
      output_tokens: 0,
      model: 'plugin',
    })
    if (result.ok) {
      this.cards = replaceCard(this.cards, result.data)
      this.render()
      return
    }
    this.handleMutationError(result.error, 'Restore failed', () => this.attemptUnarchive(cardId))
  }

  /**
   * Route a mutation error to the appropriate UI surface:
   *   conflict    → ConflictModal with Keep mine / Use server
   *   validation  → 5s Notice listing disallowed fields
   *   server      → retryable Notice
   *   offline     → silent (banner already communicates the state)
   */
  private handleMutationError(
    error: McpError,
    contextLabel: string,
    retry: () => void | Promise<void>,
  ): void {
    switch (error.kind) {
      case 'conflict':
        new ConflictModal(this.app, error, {
          keepMine: retry,
          keepTheirs: () => this.refresh(),
        }).open()
        return
      case 'validation': {
        const fields = error.disallowedFields.length > 0
          ? ` (${error.disallowedFields.join(', ')})`
          : ''
        showErrorToast(`${contextLabel}: ${error.message}${fields}`)
        return
      }
      case 'offline':
        // Offline banner already in view; suppress redundant toast.
        return
      case 'server':
        showRetryToast(`${contextLabel}: ${error.message}`, retry)
        return
    }
  }
}


function closestEl(target: EventTarget | null, selector: string): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  return target.closest(selector) as HTMLElement | null
}

function columnFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null
  const col = target.closest('.kanban-mcp-column')
  return col instanceof HTMLElement ? col : null
}
