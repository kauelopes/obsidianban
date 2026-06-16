import { Modal, Notice, TFile, type App } from 'obsidian'
import type { McpClient } from '../mcp/client.js'
import type { Sprint } from '@obsidiankan/types'

export class PastSprintsModal extends Modal {
  constructor(
    app: App,
    private readonly project: string,
    private readonly client: McpClient,
  ) {
    super(app)
  }

  override async onOpen(): Promise<void> {
    this.titleEl.setText(`Past sprints — ${this.project}`)
    this.contentEl.addClass('kanban-mcp-past-sprints-modal')

    const loading = this.contentEl.createEl('p', {
      cls: 'kanban-mcp-modal-help',
      text: 'Loading…',
    })

    const res = await this.client.listSprints({ project: this.project, status: 'closed' })
    loading.remove()

    if (!res.ok) {
      this.contentEl.createEl('p', {
        cls: 'kanban-mcp-modal-help',
        text: `Failed to load sprints: ${res.error.message}`,
      })
      return
    }

    const sprints = [...res.data.sprints].sort((a, b) => {
      const ta = a.ended_at ?? a.started_at ?? a.created_at
      const tb = b.ended_at ?? b.started_at ?? b.created_at
      return tb.localeCompare(ta)
    })

    if (sprints.length === 0) {
      this.contentEl.createEl('p', {
        cls: 'kanban-mcp-modal-help',
        text: 'No closed sprints yet.',
      })
      return
    }

    for (const sprint of sprints) {
      this.renderSprintSection(sprint)
    }
  }

  private renderSprintSection(sprint: Sprint): void {
    const section = this.contentEl.createDiv({ cls: 'kanban-mcp-past-sprint-section' })

    const header = section.createDiv({ cls: 'kanban-mcp-past-sprint-header' })
    const toggle = header.createSpan({ cls: 'kanban-mcp-past-sprint-toggle', text: '▶' })
    header.createSpan({ cls: 'kanban-mcp-past-sprint-name', text: sprint.name })

    const dateRange = formatDateRange(sprint.started_at, sprint.ended_at)
    if (dateRange) {
      header.createSpan({ cls: 'kanban-mcp-past-sprint-dates', text: dateRange })
    }

    const body = section.createDiv({ cls: 'kanban-mcp-past-sprint-body' })
    body.style.display = 'none'

    let loaded = false
    const loadCards = async (): Promise<void> => {
      if (loaded) return
      loaded = true
      body.createEl('p', { cls: 'kanban-mcp-modal-help', text: 'Loading cards…' })
      const res = await this.client.getSprint({ sprint_id: sprint.id })
      body.empty()
      if (!res.ok) {
        body.createEl('p', { cls: 'kanban-mcp-modal-help', text: 'Failed to load cards.' })
        return
      }
      const { cards, aggregates } = res.data
      const summary = body.createDiv({ cls: 'kanban-mcp-past-sprint-summary' })
      summary.createSpan({ text: `${aggregates.cards_total} cards` })
      summary.createSpan({ cls: 'kanban-mcp-past-sprint-stat kanban-mcp-past-sprint-done', text: `✓ ${aggregates.cards_done} done` })
      if (aggregates.cards_other + aggregates.cards_in_progress + aggregates.cards_todo > 0) {
        summary.createSpan({ cls: 'kanban-mcp-past-sprint-stat', text: `↩ ${aggregates.cards_other + aggregates.cards_in_progress + aggregates.cards_todo} rolled over` })
      }
      if (sprint.goal) {
        body.createEl('p', { cls: 'kanban-mcp-past-sprint-goal', text: sprint.goal })
      }
      if (cards.length === 0) {
        body.createEl('p', { cls: 'kanban-mcp-modal-help', text: 'No cards.' })
        return
      }
      const list = body.createEl('ul', { cls: 'kanban-mcp-past-sprint-cards' })
      for (const card of cards) {
        const item = list.createEl('li', { cls: 'kanban-mcp-past-sprint-card kanban-mcp-past-sprint-card-clickable' })
        item.setAttr('title', 'Open card file')
        item.createSpan({ cls: 'kanban-mcp-past-sprint-card-title', text: card.title })
        item.createSpan({
          cls: `kanban-mcp-priority kanban-mcp-priority-${card.priority}`,
          text: card.priority,
        })
        item.createSpan({
          cls: 'kanban-mcp-past-sprint-card-status',
          text: card.status,
        })
        if (card.assigned_to) {
          item.createSpan({ cls: 'kanban-mcp-assignee', text: `@${card.assigned_to}` })
        }
        item.addEventListener('click', () => void this.openCard(card, res.data.project))
      }
    }

    header.addEventListener('click', async () => {
      const open = body.style.display !== 'none'
      body.style.display = open ? 'none' : ''
      toggle.setText(open ? '▶' : '▼')
      if (!open) await loadCards()
    })
  }

  private async openCard(
    card: { id: string; title: string; file_basename: string | null },
    project: string,
  ): Promise<void> {
    const basename = card.file_basename ?? card.id
    const path = `kanban-data/${project}/${basename}.md`
    const file = this.app.vault.getAbstractFileByPath(path)
    if (file instanceof TFile) {
      this.close()
      await this.app.workspace.getLeaf(false).openFile(file)
    } else {
      new Notice(`File not found: ${path}`)
    }
  }

  override onClose(): void {
    this.contentEl.empty()
  }
}

function formatDateRange(startedAt: string | null, endedAt: string | null): string {
  const fmt = (iso: string) => iso.slice(0, 10)
  if (startedAt && endedAt) return `${fmt(startedAt)} → ${fmt(endedAt)}`
  if (endedAt) return `closed ${fmt(endedAt)}`
  return ''
}
