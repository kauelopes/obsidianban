/**
 * The card body is split into three zones with distinct write contracts:
 *
 *   # Spec       what to do — human and PM write it, dev agents read it
 *   # Notes      agent working memory — replaceable, not history
 *   # Agent Log  append-only timeline
 *
 * Legacy cards predate the convention: a body with no recognized heading is
 * entirely Spec, which is what it always meant in practice. That makes the
 * parser a superset of the current format and removes the need for a data
 * migration.
 */

export interface CardSections {
  spec: string
  notes: string
  agentLog: string
}

export const SPEC_HEADING = '# Spec'
export const NOTES_HEADING = '# Notes'
export const AGENT_LOG_HEADING = '# Agent Log'

type ZoneKey = keyof CardSections

const HEADING_TO_ZONE = new Map<string, ZoneKey>([
  ['spec', 'spec'],
  ['notes', 'notes'],
  ['agent log', 'agentLog'],
])

const FENCE_RE = /^\s*(```+|~~~+)/

/**
 * Only level-1 headings delimit zones, and only outside fenced code blocks —
 * cards carry mermaid and shell snippets whose contents would otherwise be
 * read as section boundaries.
 */
function zoneAt(line: string): ZoneKey | null {
  const m = /^#\s+(.+?)\s*$/.exec(line)
  if (!m) return null
  return HEADING_TO_ZONE.get(m[1]!.trim().toLowerCase()) ?? null
}

export function parseSections(body: string): CardSections {
  const out: CardSections = { spec: '', notes: '', agentLog: '' }
  const buffers: Record<ZoneKey, string[]> = { spec: [], notes: [], agentLog: [] }

  // Text before the first recognized heading belongs to Spec: on a legacy card
  // that is the whole body, and on a well-formed one it is a preamble the
  // human wrote above the headings.
  let current: ZoneKey = 'spec'
  let fence: string | null = null

  for (const line of body.split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (fence === null) fence = marker[0]!
      else if (marker[0] === fence) fence = null
      buffers[current].push(line)
      continue
    }
    if (fence === null) {
      const zone = zoneAt(line)
      if (zone) {
        current = zone
        continue
      }
    }
    buffers[current].push(line)
  }

  for (const key of Object.keys(buffers) as ZoneKey[]) {
    out[key] = buffers[key].join('\n').trim()
  }
  return out
}

/**
 * Canonical order, empty zones omitted. Applying this to a parsed body is
 * idempotent: serialize(parse(serialize(parse(x)))) === serialize(parse(x)).
 */
export function serializeSections(sections: CardSections): string {
  const parts: string[] = []
  if (sections.spec.trim()) parts.push(`${SPEC_HEADING}\n\n${sections.spec.trim()}`)
  if (sections.notes.trim()) parts.push(`${NOTES_HEADING}\n\n${sections.notes.trim()}`)
  if (sections.agentLog.trim()) {
    parts.push(`${AGENT_LOG_HEADING}\n\n${sections.agentLog.trim()}`)
  }
  return parts.join('\n\n')
}

/** Replace a single zone, leaving the other two untouched. */
export function replaceZone(body: string, zone: ZoneKey, content: string): string {
  const sections = parseSections(body)
  sections[zone] = content.trim()
  return serializeSections(sections)
}
