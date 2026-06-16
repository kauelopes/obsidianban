import { describe, it, expect } from 'vitest'
import { TOOL_SCHEMAS } from '../../src/server/tool-schemas.js'
import { TOOL_CATALOG } from '../../src/server/tool-catalog.js'

const VALID_TYPES = new Set(['task', 'feature', 'bug', 'chore'])
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical'])

describe('TOOL_SCHEMAS completeness', () => {
  it('every catalog tool has a schema entry', () => {
    const missing = TOOL_CATALOG.filter((t) => !(t.name in TOOL_SCHEMAS)).map((t) => t.name)
    expect(missing).toEqual([])
  })

  it('no extra schemas beyond the catalog', () => {
    const catalogNames = new Set(TOOL_CATALOG.map((t) => t.name))
    const extra = Object.keys(TOOL_SCHEMAS).filter((k) => !catalogNames.has(k))
    expect(extra).toEqual([])
  })
})

describe('TOOL_SCHEMAS structural validity', () => {
  it("every schema has type = 'object'", () => {
    const wrong = Object.entries(TOOL_SCHEMAS)
      .filter(([, s]) => (s as Record<string, unknown>).type !== 'object')
      .map(([k]) => k)
    expect(wrong).toEqual([])
  })

  it('every schema has additionalProperties: false', () => {
    const wrong = Object.entries(TOOL_SCHEMAS)
      .filter(([, s]) => (s as Record<string, unknown>).additionalProperties !== false)
      .map(([k]) => k)
    expect(wrong).toEqual([])
  })

  it('required fields are arrays when present', () => {
    const wrong = Object.entries(TOOL_SCHEMAS)
      .filter(([, s]) => {
        const schema = s as Record<string, unknown>
        return 'required' in schema && !Array.isArray(schema.required)
      })
      .map(([k]) => k)
    expect(wrong).toEqual([])
  })

  it('enum values for card type field are consistent across schemas', () => {
    for (const [toolName, schema] of Object.entries(TOOL_SCHEMAS)) {
      const props = (schema as Record<string, unknown>).properties as
        | Record<string, Record<string, unknown>>
        | undefined
      if (!props) continue
      const typeProp = props['type']
      if (!typeProp || !Array.isArray(typeProp['enum'])) continue
      const invalid = (typeProp['enum'] as string[]).filter((v) => !VALID_TYPES.has(v))
      expect(invalid, `${toolName}.type enum has unexpected values`).toEqual([])
    }
  })

  it('enum values for priority field are consistent across schemas', () => {
    for (const [toolName, schema] of Object.entries(TOOL_SCHEMAS)) {
      const props = (schema as Record<string, unknown>).properties as
        | Record<string, Record<string, unknown>>
        | undefined
      if (!props) continue
      const priorityProp = props['priority']
      if (!priorityProp || !Array.isArray(priorityProp['enum'])) continue
      const invalid = (priorityProp['enum'] as string[]).filter((v) => !VALID_PRIORITIES.has(v))
      expect(invalid, `${toolName}.priority enum has unexpected values`).toEqual([])
    }
  })

  it('array-typed properties have an items field', () => {
    for (const [toolName, schema] of Object.entries(TOOL_SCHEMAS)) {
      const props = (schema as Record<string, unknown>).properties as
        | Record<string, Record<string, unknown>>
        | undefined
      if (!props) continue
      for (const [propName, propDef] of Object.entries(props)) {
        if (propDef['type'] === 'array') {
          expect(
            propDef['items'],
            `${toolName}.${propName} is type array but missing items`,
          ).toBeDefined()
        }
      }
    }
  })
})

describe('TOOL_SCHEMAS per-tool spot checks', () => {
  it('kanban_create_card requires title, type, sprint_id', () => {
    const schema = TOOL_SCHEMAS['kanban_create_card'] as Record<string, unknown>
    expect(schema['required']).toContain('title')
    expect(schema['required']).toContain('type')
    expect(schema['required']).toContain('sprint_id')
  })

  it('kanban_get_card requires id', () => {
    const schema = TOOL_SCHEMAS['kanban_get_card'] as Record<string, unknown>
    expect(schema['required']).toContain('id')
  })

  it('kanban_update_card requires id and version', () => {
    const schema = TOOL_SCHEMAS['kanban_update_card'] as Record<string, unknown>
    expect(schema['required']).toContain('id')
    expect(schema['required']).toContain('version')
  })

  it('kanban_create_project requires project and actor', () => {
    const schema = TOOL_SCHEMAS['kanban_create_project'] as Record<string, unknown>
    expect(schema['required']).toContain('project')
    expect(schema['required']).toContain('actor')
  })

  it('kanban_log_on_card requires id, version, log_entry', () => {
    const schema = TOOL_SCHEMAS['kanban_log_on_card'] as Record<string, unknown>
    expect(schema['required']).toContain('id')
    expect(schema['required']).toContain('version')
    expect(schema['required']).toContain('log_entry')
  })
})
