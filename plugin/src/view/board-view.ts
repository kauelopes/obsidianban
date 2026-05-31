import { ItemView, Menu, Notice, TFile, type WorkspaceLeaf } from 'obsidian'
import type KanbanPlugin from '../main.js'
import type {
  CardSummary,
  CardCreatedPayload,
  CardDeletedPayload,
  CardMovedPayload,
  CardReorderedPayload,
  CardUpdatedPayload,
  CardHumanEditedPayload,
  ProjectArchivedPayload,
  ProjectDeletedPayload,
} from '../../../src/types.js'
import type { McpError } from '../mcp/client.js'
import type { SSEFrame, SseStatus } from '../mcp/sse-subscriber.js'
import { ConflictModal } from '../ui/conflict-modal.js'
import { ConfirmModal } from '../ui/confirm-modal.js'
import { ChangeSprintModal } from '../ui/change-sprint-modal.js'
import { BlockerWarningModal } from '../ui/blocker-warning-modal.js'
import { PastSprintsModal } from '../ui/past-sprints-modal.js'
import { HelpModal } from '../ui/help-modal.js'
import { CreateCardModal } from '../ui/create-card-modal.js'
import { DeleteProjectModal } from '../ui/delete-project-modal.js'
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
  private projectShapes: Array<{ project: string; columns: readonly string[]; archived: boolean }> = []
  /** Active sprints by project, keyed for fast lookup during render. */
  private sprintsByProject: Map<string, import('../../../src/types.js').Sprint[]> = new Map()
  /** Sprint filter per project: undefined = "All", string = sprint_id. */
  private selectedSprintByProject: Map<string, string> = new Map()

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
    // onChange removed — sprint selection now uses click on tab buttons
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
    const showArchived = this.plugin.settings.showArchived
    const [cardsResult, projectsResult] = await Promise.all([
      client.listCards({
        include_archived: showArchived,
        include_archived_projects: showArchived,
      }),
      client.listProjects({ include_archived: showArchived }),
    ])
    if (!cardsResult.ok) {
      this.renderError(`MCP ${cardsResult.error.kind}: ${cardsResult.error.message}`)
      return
    }
    this.cards = [...cardsResult.data.cards]
    this.projectShapes = projectsResult.ok ? [...projectsResult.data.projects] : []

    // Fetch sprints for every visible project in parallel. Failures degrade
    // silently — no sprint UI for that project but the board still renders.
    this.sprintsByProject = new Map()
    const projectsToFetch = this.projectShapes.map((p) => p.project)
    const sprintResults = await Promise.all(
      projectsToFetch.map(async (project) => {
        const r = await client.listSprints({ project, status: 'open' })
        return { project, sprints: r.ok ? r.data.sprints : [] }
      }),
    )
    for (const { project, sprints } of sprintResults) {
      if (sprints.length > 0) this.sprintsByProject.set(project, sprints)
    }
    this.render()
  }

  private render(): void {
    this.contentEl.empty()
    this.renderToolbar()
    const boardContent = this.contentEl.createDiv({ cls: 'kanban-mcp-board-content' })
    if (this.plugin.connectionStatus !== 'connected') {
      this.renderOfflineBanner(this.plugin.connectionStatus, boardContent)
    }
    const shapes = this.projectShapes.map((p) => ({
      project: p.project,
      columns: p.columns,
      archived: p.archived,
      sprints: this.sprintsByProject.get(p.project) ?? [],
      selectedSprint: this.selectedSprintByProject.get(p.project),
    }))
    // Cards archived via sprint-close (archived + sprint_id pointing to a
    // closed sprint) must never appear on the board — they live in "Past
    // sprints" only. Build a set of open sprint IDs so we can detect them.
    const openSprintIds = new Set<string>()
    for (const sprints of this.sprintsByProject.values()) {
      for (const s of sprints) openSprintIds.add(s.id)
    }
    const boardCards = this.cards.filter((c) => {
      if (!c.archived) return true
      // Archived card whose sprint is closed → hide unconditionally.
      if (c.sprint_id != null && !openSprintIds.has(c.sprint_id)) return false
      // Manually archived card → respect showArchived setting.
      return this.plugin.settings.showArchived
    })
    renderBoard(boardContent, boardCards, todayString(), shapes)
  }

  private renderToolbar(): void {
    const bar = this.contentEl.createDiv({ cls: 'kanban-mcp-topbar' })
    bar.createSpan({ cls: 'kanban-mcp-topbar-brand', text: 'ObsidianKan' })
    const actions = bar.createDiv({ cls: 'kanban-mcp-topbar-actions' })
    actions.createEl('button', {
      cls: 'kanban-mcp-new-project-btn',
      text: '+ New project',
      attr: { type: 'button', 'aria-label': 'Create kanban project' },
    })
    const helpBtn = actions.createEl('button', {
      cls: 'kanban-mcp-help-btn',
      text: '? Help',
      attr: { type: 'button', 'aria-label': 'Open agent onboarding help' },
    })
    helpBtn.dataset['action'] = 'open-help'
  }

  private renderOfflineBanner(status: SseStatus, parent: HTMLElement = this.contentEl): void {
    const banner = parent.createDiv({ cls: 'kanban-mcp-offline-banner' })
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
    this.renderToolbar()
    this.contentEl.createDiv({ cls: 'kanban-mcp-board-content' })
      .createDiv({ cls: 'kanban-mcp-error', text: msg })
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
      case 'PROJECT_ARCHIVED':
      case 'PROJECT_UNARCHIVED':
      case 'PROJECT_DELETED': {
        // Project-level mutations change which projects/cards are visible
        // in ways the local card list can't reconstruct cheaply. The full
        // refresh is the simplest correct response and these events are
        // infrequent.
        const _p = frame.data as ProjectArchivedPayload | ProjectDeletedPayload
        void this.refresh()
        return
      }
      case 'SPRINT_CREATED':
      case 'SPRINT_STARTED':
      case 'SPRINT_UPDATED':
      case 'SPRINT_CLOSED': {
        // Sprint-shape changes (new sprint, membership change, close)
        // affect what the selector shows and which cards belong where —
        // refetch wholesale, same logic as the project events above.
        void this.refresh()
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
    const menuBtn = closestEl(e.target, '.kanban-mcp-project-menu')
    if (menuBtn) {
      e.stopPropagation()
      const project = menuBtn.dataset['project']
      const archived = menuBtn.dataset['archived'] === 'true'
      if (project) this.openProjectMenu(e, project, archived)
      return
    }
    const newProjectBtn = closestEl(e.target, '.kanban-mcp-new-project-btn')
    if (newProjectBtn) {
      e.stopPropagation()
      this.plugin.promptCreateProject()
      return
    }
    const helpBtn = closestEl(e.target, '.kanban-mcp-help-btn')
    if (helpBtn) {
      e.stopPropagation()
      new HelpModal(this.app, this).open()
      return
    }
    const sprintActionBtn = closestEl(e.target, '.kanban-mcp-sprint-action')
    if (sprintActionBtn) {
      e.stopPropagation()
      const project = sprintActionBtn.dataset['project']
      const sprintId = sprintActionBtn.dataset['sprint']
      const action = sprintActionBtn.dataset['action']
      if (project && sprintId && action === 'start') {
        void this.attemptStartSprint(project, sprintId)
      } else if (project && sprintId && action === 'close') {
        void this.promptCloseSprint(project, sprintId)
      }
      return
    }
    const addBtn = closestEl(e.target, '.kanban-mcp-column-add')
    if (addBtn) {
      const project = addBtn.dataset['project']
      const status = addBtn.dataset['status']
      if (project && status) this.promptCreate(project, status)
      return
    }
    // Card-level … menu must short-circuit before the card-open fallback so
    // clicking the button doesn't also open the .md file.
    const cardMenuBtn = closestEl(e.target, '.kanban-mcp-card-menu')
    if (cardMenuBtn) {
      e.stopPropagation()
      const cardId = cardMenuBtn.dataset['cardId']
      if (cardId) this.openCardMenu(e, cardId)
      return
    }
    const sprintTab = closestEl(e.target, '.kanban-mcp-sprint-tab')
    if (sprintTab) {
      const project = sprintTab.dataset['project']
      const sprintId = sprintTab.dataset['sprintId']
      if (project != null) {
        if (!sprintId) this.selectedSprintByProject.delete(project)
        else this.selectedSprintByProject.set(project, sprintId)
        this.render()
      }
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

    // Block forward movement when the card's sprint is not active. "Forward"
    // is determined by the project's column order; lateral/backward moves
    // (e.g. reopening a card) are always allowed.
    if (original.sprint_id) {
      const sprint = (this.sprintsByProject.get(original.project) ?? [])
        .find((s) => s.id === original.sprint_id)
      if (sprint && sprint.status !== 'active') {
        const columns = this.projectShapes.find((p) => p.project === original.project)?.columns
          ?? DEFAULT_COLUMN_ORDER
        const fromIdx = columns.indexOf(original.status)
        const toIdx = columns.indexOf(targetStatus)
        const isForward = toIdx > fromIdx
        if (isForward) {
          const reason = sprint.status === 'planning'
            ? `Sprint "${sprint.name}" hasn't started yet. Start the sprint before advancing cards.`
            : `Sprint "${sprint.name}" is closed. Cards from closed sprints cannot be advanced.`
          new Notice(reason, 6000)
          return
        }
      }
    }

    // Check for pending blockers before hitting the server. A blocker is
    // "pending" if it exists in the local card list and is not in "done".
    if (original.blocked_by && original.blocked_by.length > 0) {
      const pendingBlockers = original.blocked_by
        .map((id) => this.cards.find((c) => c.id === id))
        .filter((c) => c != null && c.status !== 'done')
        .map((c) => ({ id: c!.id, title: c!.title, status: c!.status }))
      if (pendingBlockers.length > 0) {
        new BlockerWarningModal(this.app, original.title, pendingBlockers).open()
        return
      }
    }

    this.doMove(cardId, targetProject, targetStatus, original)
  }

  private async doMove(cardId: string, targetProject: string, targetStatus: string, original: CardSummary): Promise<void> {
    const client = this.plugin.client
    if (!client) return
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
    const sprints = this.sprintsByProject.get(project) ?? []
    if (sprints.length === 0) {
      new Notice(
        `Project "${project}" has no open sprint. ` +
        'Use the project menu (⋯) → "New sprint…" to create one before adding cards.',
        8000,
      )
      return
    }
    // Build sprint_id → candidate cards lookup once, so the modal can
    // populate the "Blocked by" picker reactively when the user changes
    // sprints without us needing to refetch.
    const candidatesBySprint = new Map<string, Array<{ id: string; title: string }>>()
    for (const card of this.cards) {
      if (card.project !== project) continue
      if (card.sprint_id == null) continue
      if (card.archived) continue
      const arr = candidatesBySprint.get(card.sprint_id) ?? []
      arr.push({ id: card.id, title: card.title })
      candidatesBySprint.set(card.sprint_id, arr)
    }
    for (const arr of candidatesBySprint.values()) {
      arr.sort((a, b) => a.title.localeCompare(b.title))
    }
    new CreateCardModal(this.app, sprints, candidatesBySprint, async (input) => {
      await this.attemptCreate(project, status, input)
    }).open()
  }

  private async attemptCreate(
    project: string,
    status: string,
    input: import('../ui/create-card-modal.js').CreateCardInput,
  ): Promise<void> {
    const client = this.plugin.client
    if (!client) return

    const now = new Date().toISOString()
    const tempId = `card-optimistic-${Date.now()}`
    const placeholder: CardSummary = {
      id: tempId,
      project,
      title: input.title,
      status,
      type: input.type,
      version: 0,
      position: OPTIMISTIC_POSITION,
      priority: input.priority,
      tags: input.tags,
      due_date: input.due_date,
      assigned_to: input.assigned_to,
      owner: null,
      agent_notes: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      archived: false,
      sprint_id: input.sprint_id,
      blocked_by: input.blocked_by,
      created_at: now,
      updated_at: now,
      created_by: 'human:plugin',
      updated_by: 'human:plugin',
    }
    const snapshot = this.cards
    this.cards = appendCard(this.cards, placeholder)
    this.render()

    const result = await client.createCard({
      title: input.title,
      type: input.type,
      project,
      status,
      priority: input.priority,
      tags: input.tags.length > 0 ? input.tags : undefined,
      due_date: input.due_date ?? undefined,
      assigned_to: input.assigned_to ?? undefined,
      blocked_by: input.blocked_by.length > 0 ? input.blocked_by : undefined,
      sprint_id: input.sprint_id,
      body: input.body.trim() || undefined,
      input_tokens: 0,
      output_tokens: 0,
      model: 'plugin',
    })
    if (!result.ok) {
      this.cards = [...snapshot]
      this.render()
      this.handleMutationError(result.error, 'Create failed', () =>
        this.attemptCreate(project, status, input),
      )
      return
    }
    this.cards = replaceCard(removeCard(this.cards, tempId), result.data)
    this.render()
  }

  private openCardMenu(e: MouseEvent, cardId: string): void {
    const card = this.cards.find((c) => c.id === cardId)
    if (!card) return
    const menu = new Menu()

    if (card.archived) {
      menu.addItem((item) =>
        item
          .setTitle('Restore card')
          .setIcon('archive-restore')
          .onClick(() => void this.attemptUnarchive(cardId)),
      )
    } else {
      menu.addItem((item) =>
        item
          .setTitle('Archive card')
          .setIcon('archive')
          .onClick(() => void this.attemptArchive(cardId)),
      )
    }

    // Change sprint — single item; opens a picker modal with all open sprints
    // (planning + active) except the one the card already belongs to.
    const availableSprints = (this.sprintsByProject.get(card.project) ?? [])
      .filter((s) => s.id !== card.sprint_id)
    if (availableSprints.length > 0) {
      menu.addSeparator()
      menu.addItem((item) =>
        item
          .setTitle('Change sprint…')
          .setIcon('calendar-arrow-up')
          .onClick(() => {
            new ChangeSprintModal(this.app, card.title, availableSprints, (sprintId) => {
              void this.attemptChangeSprint(card, sprintId)
            }).open()
          }),
      )
    }

    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle('Delete card…')
        .setIcon('trash')
        .onClick(() => void this.promptDeleteCard(cardId))
        .setWarning(true),
    )

    menu.showAtMouseEvent(e)
  }

  private async promptDeleteCard(cardId: string): Promise<void> {
    const card = this.cards.find((c) => c.id === cardId)
    if (!card) return
    new ConfirmModal(this.app, {
      title: 'Delete card?',
      body: `Permanently delete "${card.title}". This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
    }, async (ok) => {
      if (!ok) return
      const client = this.plugin.client
      if (!client) return
      const snapshot = this.cards
      this.cards = removeCard(this.cards, cardId)
      this.render()
      const result = await client.deleteCard({
        id: cardId,
        version: card.version,
        input_tokens: 0,
        output_tokens: 0,
        model: 'plugin',
      })
      if (!result.ok) {
        this.cards = [...snapshot]
        this.render()
        this.handleMutationError(result.error, 'Delete failed', () =>
          this.promptDeleteCard(cardId),
        )
      }
    }).open()
  }

  private async attemptChangeSprint(
    card: CardSummary,
    targetSprintId: string,
  ): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    if (!card.sprint_id) {
      new Notice('Card has no source sprint — use "Add to sprint" instead')
      return
    }
    const result = await client.moveBetweenSprints({
      sprint_id: card.sprint_id,
      target_sprint_id: targetSprintId,
      card_ids: [card.id],
    })
    if (!result.ok) {
      this.handleMutationError(result.error, 'Change sprint failed', () =>
        this.attemptChangeSprint(card, targetSprintId),
      )
      return
    }
    const failed = result.data.failed
    if (failed.length > 0) {
      new Notice(`Could not move card: ${failed[0]?.reason ?? 'unknown reason'}`, 6000)
      return
    }
    void this.refresh()
  }

  private openProjectMenu(e: MouseEvent, project: string, archived: boolean): void {
    const menu = new Menu()
    menu.addItem((item) =>
      item
        .setTitle('New sprint…')
        .setIcon('calendar-plus')
        .onClick(() => this.plugin.promptCreateSprint(project)),
    )
    const selectedSprintId = this.selectedSprintByProject.get(project)
    if (selectedSprintId != null) {
      const sprint = (this.sprintsByProject.get(project) ?? [])
        .find((s) => s.id === selectedSprintId)
      if (sprint?.status === 'planning') {
        menu.addItem((item) =>
          item
            .setTitle('Start sprint')
            .setIcon('play')
            .onClick(() => void this.attemptStartSprint(project, selectedSprintId)),
        )
      } else if (sprint?.status === 'active') {
        menu.addItem((item) =>
          item
            .setTitle('Close current sprint…')
            .setIcon('calendar-check')
            .onClick(() => void this.promptCloseSprint(project, selectedSprintId)),
        )
      }
    }
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle('Past sprints…')
        .setIcon('history')
        .onClick(() => {
          const client = this.plugin.client
          if (client) new PastSprintsModal(this.app, project, client).open()
        }),
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle(archived ? 'Unarchive project' : 'Archive project')
        .setIcon(archived ? 'archive-restore' : 'archive')
        .onClick(() => {
          if (archived) void this.attemptUnarchiveProject(project)
          else void this.attemptArchiveProject(project)
        }),
    )
    menu.addItem((item) =>
      item
        .setTitle('Show agent tokens')
        .setIcon('lock')
        .onClick(() => void this.openSecretsNote(project)),
    )
    menu.addItem((item) =>
      item
        .setTitle('Mint new PM token')
        .setIcon('key')
        .onClick(() => this.plugin.promptMintPmToken(project)),
    )
    menu.addItem((item) =>
      item
        .setTitle('Mint new Dev token')
        .setIcon('pencil')
        .onClick(() => this.plugin.promptMintDevToken(project)),
    )
    menu.addSeparator()
    menu.addItem((item) =>
      item
        .setTitle('Delete project…')
        .setIcon('trash')
        .onClick(() => void this.promptDeleteProject(project))
        // Obsidian's Menu API exposes setWarning to render destructive items
        // in the error color so users see the danger at a glance.
        .setWarning(true),
    )
    menu.showAtMouseEvent(e)
  }

  private async openSecretsNote(project: string): Promise<void> {
    const notePath = `_kanban-secrets/${project}.md`
    const file = this.app.vault.getAbstractFileByPath(notePath)
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(file)
    } else {
      showErrorToast(`No token note found for project "${project}". Create the project first or mint a token.`)
    }
  }

  async attemptStartSprint(project: string, sprintId: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const res = await client.startSprint({ sprint_id: sprintId })
    if (!res.ok) {
      this.handleMutationError(res.error, 'Start sprint failed', () =>
        this.attemptStartSprint(project, sprintId),
      )
      return
    }
    new Notice(`Sprint "${res.data.name}" is now active.`)
    void this.refresh()
  }

  private async promptCloseSprint(project: string, sprintId: string): Promise<void> {
    const sprints = this.sprintsByProject.get(project) ?? []
    const sprint = sprints.find((s) => s.id === sprintId)
    if (!sprint) {
      new Notice(`Sprint ${sprintId} not found`)
      return
    }

    const unfinished = this.cards.filter(
      (c) => c.sprint_id === sprintId && c.status !== 'done' && !c.archived,
    )
    const hasUnfinished = unfinished.length > 0

    // Only ask for a rollover target when there are cards that aren't done.
    const pickRollover = (onPicked: (rolloverSprintId: string | null) => void): void => {
      if (!hasUnfinished) {
        onPicked(null)
        return
      }
      const planningSprints = sprints.filter((s) => s.id !== sprintId && s.status === 'planning')
      if (planningSprints.length === 0) {
        new Notice(
          `Create a planning sprint first — ${unfinished.length} unfinished card(s) need somewhere to roll over to.`,
          8000,
        )
        return
      }
      if (planningSprints.length === 1) {
        onPicked(planningSprints[0]!.id)
        return
      }
      new ChangeSprintModal(this.app, `Unfinished cards from "${sprint.name}"`, planningSprints, onPicked).open()
    }

    pickRollover((rolloverTo) => {
      const rolloverSprint = rolloverTo
        ? sprints.find((s) => s.id === rolloverTo)
        : null
      const body = rolloverSprint
        ? `Close "${sprint.name}". Unfinished cards will roll over to "${rolloverSprint.name}".`
        : `Close "${sprint.name}". All cards are done and will be archived.`
      new ConfirmModal(this.app, {
        title: 'Close sprint?',
        body,
        confirmLabel: 'Close sprint',
        cancelLabel: 'Cancel',
      }, async (ok) => {
        if (!ok) return
        const client = this.plugin.client
        if (!client) return
        const res = await client.closeSprint({
          sprint_id: sprintId,
          rollover_to: rolloverTo ?? undefined,
        })
        if (!res.ok) {
          this.handleMutationError(res.error, 'Close sprint failed', () =>
            this.promptCloseSprint(project, sprintId),
          )
          return
        }
        const msg = rolloverSprint
          ? `Sprint closed — ${res.data.finished.length} cards archived, ${res.data.rolled_over.length} rolled over to "${rolloverSprint.name}"`
          : `Sprint closed — ${res.data.finished.length} cards archived`
        new Notice(msg)
        this.selectedSprintByProject.delete(project)
        void this.refresh()
      }).open()
    })
  }

  private async attemptArchiveProject(project: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const res = await client.archiveProject({ project })
    if (!res.ok) {
      this.handleMutationError(res.error, 'Archive project failed', () =>
        this.attemptArchiveProject(project),
      )
      return
    }
    new Notice(`Project "${project}" archived`)
    void this.refresh()
  }

  private async attemptUnarchiveProject(project: string): Promise<void> {
    const client = this.plugin.client
    if (!client) return
    const res = await client.unarchiveProject({ project })
    if (!res.ok) {
      this.handleMutationError(res.error, 'Unarchive project failed', () =>
        this.attemptUnarchiveProject(project),
      )
      return
    }
    new Notice(`Project "${project}" restored`)
    void this.refresh()
  }

  private async promptDeleteProject(project: string): Promise<void> {
    const cardCount = this.cards.filter((c) => c.project === project).length
    new DeleteProjectModal(this.app, project, cardCount, async () => {
      const client = this.plugin.client
      if (!client) return
      const res = await client.deleteProject({ project, confirm: project })
      if (!res.ok) {
        this.handleMutationError(res.error, 'Delete project failed', () => {
          void this.promptDeleteProject(project)
        })
        return
      }
      new Notice(`Project "${project}" deleted (${res.data.cards_deleted} cards removed)`)
      void this.refresh()
    }).open()
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
