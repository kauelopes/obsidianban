import { Modal, type App } from 'obsidian'
import type { Priority, Sprint } from '../../../src/types.js'

export interface PredecessorCandidate {
  id: string
  title: string
}

export interface CreateCardInput {
  title: string
  type: string
  priority: Priority
  tags: string[]
  due_date: string | null
  assigned_to: string | null
  sprint_id: string         // required — every new card must belong to a sprint
  blocked_by: string[]
}

const TYPE_SUGGESTIONS = ['task', 'bug', 'spike', 'chore', 'docs']
const PRIORITIES: Priority[] = ['low', 'medium', 'high', 'critical']

export class CreateCardModal extends Modal {
  constructor(
    app: App,
    private readonly activeSprints: Sprint[],
    /**
     * Maps sprint_id → cards in the same project that already belong to
     * that sprint. Used to populate the "Blocked by" picker when the user
     * selects a sprint. Cross-sprint blockers aren't offered: dependencies
     * are sprint-local so the agent's pick_next stays solvable within the
     * sprint context.
     */
    private readonly candidatesBySprint: Map<string, PredecessorCandidate[]>,
    private readonly onSubmit: (input: CreateCardInput) => void | Promise<void>,
  ) {
    super(app)
  }

  override onOpen(): void {
    this.titleEl.setText('New card')
    const form = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-form' })

    const titleInput = this.field(form, 'Title', 'input', {
      type: 'text', placeholder: 'Card title',
    }) as HTMLInputElement
    titleInput.focus()

    const typeListId = `kanban-mcp-type-list-${Date.now()}`
    const typeInput = this.field(form, 'Type', 'input', {
      type: 'text', placeholder: 'task', value: 'task', list: typeListId,
    }) as HTMLInputElement
    const datalist = form.createEl('datalist', { attr: { id: typeListId } })
    for (const t of TYPE_SUGGESTIONS) datalist.createEl('option', { attr: { value: t } })

    const prioritySelect = this.field(form, 'Priority', 'select', {}) as HTMLSelectElement
    for (const p of PRIORITIES) {
      const opt = prioritySelect.createEl('option', { text: p, attr: { value: p } })
      if (p === 'medium') opt.selected = true
    }

    // Sprint is mandatory under the project rule: a card cannot exist
    // outside a sprint. If no planning/active sprint exists, the picker is
    // omitted and submit is locked.
    const sprintSelect = this.field(form, 'Sprint', 'select', {}) as HTMLSelectElement
    if (this.activeSprints.length === 0) {
      sprintSelect.createEl('option', {
        text: '— no open sprint — create one first',
        attr: { value: '' },
      })
      sprintSelect.disabled = true
    } else {
      for (const s of this.activeSprints) {
        sprintSelect.createEl('option', {
          text: `${s.name} (${s.status})`,
          attr: { value: s.id },
        })
      }
    }

    // Predecessor picker: shown only when the selected sprint has other cards.
    // Hidden entirely otherwise — no empty/disabled state to confuse the user.
    const blockedWrap = form.createDiv({ cls: 'kanban-mcp-modal-field' })
    blockedWrap.createEl('label', { text: 'Blocked by', cls: 'kanban-mcp-modal-label' })
    const blockedSelect = blockedWrap.createEl('select', {
      cls: 'kanban-mcp-modal-input',
    })

    const refreshBlocked = (): void => {
      blockedSelect.empty()
      const sprintId = sprintSelect.value ?? ''
      const candidates = sprintId ? this.candidatesBySprint.get(sprintId) ?? [] : []
      if (candidates.length === 0) {
        blockedWrap.style.display = 'none'
        return
      }
      blockedWrap.style.display = ''
      blockedSelect.createEl('option', { text: '— None —', attr: { value: '' } })
      for (const c of candidates) {
        blockedSelect.createEl('option', {
          text: c.title,
          attr: { value: c.id, title: c.id },
        })
      }
    }
    sprintSelect.addEventListener('change', refreshBlocked)
    refreshBlocked()

    const tagsInput = this.field(form, 'Tags', 'input', {
      type: 'text', placeholder: 'comma-separated (backend, auth)',
    }) as HTMLInputElement

    const dueInput = this.field(form, 'Due date', 'input', { type: 'date' }) as HTMLInputElement

    const assignedInput = this.field(form, 'Assigned to', 'input', {
      type: 'text', placeholder: 'agent:alice (optional)',
    }) as HTMLInputElement

    const submit = async (): Promise<void> => {
      const title = titleInput.value.trim()
      if (!title) { titleInput.focus(); return }
      const sprintId = sprintSelect.value
      if (!sprintId) return // submit is also gated by the disabled button below
      const type = typeInput.value.trim() || 'task'
      const tags = tagsInput.value
        .split(',').map((t) => t.trim()).filter((t) => t.length > 0)
      const due = dueInput.value.trim()
      const assigned = assignedInput.value.trim()
      const blockedBy = blockedSelect.value ? [blockedSelect.value] : []
      this.close()
      await this.onSubmit({
        title,
        type,
        priority: prioritySelect.value as Priority,
        tags,
        due_date: due.length > 0 ? due : null,
        assigned_to: assigned.length > 0 ? assigned : null,
        sprint_id: sprintId,
        blocked_by: blockedBy,
      })
    }

    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void submit()
    })

    const row = this.contentEl.createDiv({ cls: 'kanban-mcp-modal-buttons' })
    const btn = row.createEl('button', { text: 'Create', cls: 'mod-cta' })
    if (this.activeSprints.length === 0) {
      btn.disabled = true
      btn.setAttr('title', 'Create a sprint first')
    }
    btn.addEventListener('click', () => void submit())
  }

  private field(
    parent: HTMLElement,
    label: string,
    tag: 'input' | 'select',
    attrs: Record<string, string>,
  ): HTMLInputElement | HTMLSelectElement {
    const wrap = parent.createDiv({ cls: 'kanban-mcp-modal-field' })
    wrap.createEl('label', { text: label, cls: 'kanban-mcp-modal-label' })
    const el = wrap.createEl(tag, {
      cls: 'kanban-mcp-modal-input',
      attr: attrs,
    }) as HTMLInputElement | HTMLSelectElement
    return el
  }
}
