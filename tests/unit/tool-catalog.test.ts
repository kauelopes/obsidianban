import { describe, it, expect } from 'vitest'
import { TOOL_CATALOG } from '../../src/server/tool-catalog.js'

const VALID_ACCESS = new Set(['all', 'pm', 'manager'])
const VALID_CATEGORIES = new Set(['Cards', 'Workflow', 'Projetos', 'Auth', 'Sprints'])

describe('TOOL_CATALOG structural integrity', () => {
  it('has at least one entry', () => {
    expect(TOOL_CATALOG.length).toBeGreaterThan(0)
  })

  it('every entry has a non-empty name', () => {
    expect(TOOL_CATALOG.every((t) => typeof t.name === 'string' && t.name.length > 0)).toBe(true)
  })

  it('every entry has a non-empty description', () => {
    expect(TOOL_CATALOG.every((t) => typeof t.description === 'string' && t.description.length > 0)).toBe(true)
  })

  it('every access value is a valid ToolAccess', () => {
    const invalid = TOOL_CATALOG.filter((t) => !VALID_ACCESS.has(t.access))
    expect(invalid).toEqual([])
  })

  it('every category is a valid ToolCategory', () => {
    const invalid = TOOL_CATALOG.filter((t) => !VALID_CATEGORIES.has(t.category))
    expect(invalid).toEqual([])
  })

  it('has no duplicate tool names', () => {
    const names = TOOL_CATALOG.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('all tool names start with kanban_', () => {
    const wrong = TOOL_CATALOG.filter((t) => !t.name.startsWith('kanban_'))
    expect(wrong).toEqual([])
  })

  it("manager-only tools belong to Projetos or Auth categories", () => {
    const managerTools = TOOL_CATALOG.filter((t) => t.access === 'manager')
    expect(managerTools.length).toBeGreaterThan(0)
    const wrongCategory = managerTools.filter(
      (t) => t.category !== 'Projetos' && t.category !== 'Auth',
    )
    expect(wrongCategory).toEqual([])
  })

  it("dev-accessible tools include kanban_pick_next, kanban_move_card, kanban_log_on_card", () => {
    const allAccess = TOOL_CATALOG.filter((t) => t.access === 'all').map((t) => t.name)
    expect(allAccess).toContain('kanban_pick_next')
    expect(allAccess).toContain('kanban_move_card')
    expect(allAccess).toContain('kanban_log_on_card')
  })
})
