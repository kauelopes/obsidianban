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

// ─── Entradas do Agent Log ────────────────────────────────────────────────────

/**
 * Natureza de uma entrada do log.
 *
 * Antes disto uma escalação era convenção em texto livre — o PRD descrevia um
 * marcador `[ESCALATE]` que, conferido, não existia em lugar nenhum do código
 * nem dos vaults. Com o campo estruturado a inbox de escalações passa a ser uma
 * consulta em vez de um regex, e as skills de PM/Dev ganham um contrato
 * verificável em vez de um prefixo combinado.
 */
export type LogKind = 'progress' | 'escalate' | 'done' | 'pm_resolved'

const LOG_KINDS = new Set<string>(['progress', 'escalate', 'done', 'pm_resolved'])

export function isLogKind(v: unknown): v is LogKind {
  return typeof v === 'string' && LOG_KINDS.has(v)
}

export interface LogEntry {
  /** ISO 8601, ou null num preâmbulo de card legado sem timestamp. */
  ts: string | null
  kind: LogKind
  text: string
  /** true quando o kind foi lido de um marcador, e não presumido. */
  explicit: boolean
}

/**
 * Cabeçalho de uma entrada: o timestamp em negrito, opcionalmente seguido do
 * kind entre backticks.
 *
 *     **2026-06-01T02:11:00Z** `escalate`
 *
 * O marcador é omitido quando o kind é `progress`, que é o caso comum — assim
 * o log não vira ruído no Obsidian e todo card legado continua válido, porque
 * ausência de marcador significa `progress`.
 */
const ENTRY_HEAD_RE = /^\*\*(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\*\*(?:\s*`([a-z_]+)`)?\s*$/

/** Retrocompatibilidade com o marcador em texto que o PRD descrevia. */
const LEGACY_ESCALATE_RE = /^\s*\[ESCALATE\]\s*/i

export function formatLogHeading(ts: string, kind: LogKind = 'progress'): string {
  return kind === 'progress' ? `**${ts}**` : `**${ts}** \`${kind}\``
}

/**
 * Divide o `# Agent Log` em entradas.
 *
 * Substitui o `splitLogEntries` que vivia em packages/web/src/card/CardDetail.tsx
 * — a divisão é parte do contrato do formato, então mora no pacote normativo e
 * é testada uma vez só.
 */
export function parseLogEntries(agentLog: string): LogEntry[] {
  if (!agentLog.trim()) return []

  const out: Array<{ ts: string | null; kind: LogKind; explicit: boolean; lines: string[] }> = []
  let fence: string | null = null

  for (const line of agentLog.split(/\r?\n/)) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const marker = fenceMatch[1]!
      if (fence === null) fence = marker[0]!
      else if (marker[0] === fence) fence = null
      if (out.length > 0) out[out.length - 1]!.lines.push(line)
      else out.push({ ts: null, kind: 'progress', explicit: false, lines: [line] })
      continue
    }

    // Um cabeçalho dentro de bloco de código é conteúdo, não separador — os
    // cards carregam mermaid e snippets de shell.
    const head = fence === null ? ENTRY_HEAD_RE.exec(line.trim()) : null
    if (head) {
      const rawKind = head[2]
      out.push({
        ts: head[1]!,
        kind: isLogKind(rawKind) ? rawKind : 'progress',
        explicit: isLogKind(rawKind),
        lines: [],
      })
      continue
    }

    if (out.length === 0) out.push({ ts: null, kind: 'progress', explicit: false, lines: [line] })
    else out[out.length - 1]!.lines.push(line)
  }

  return out.map((e) => {
    let text = e.lines.join('\n').trim()
    let kind = e.kind
    let explicit = e.explicit
    if (!explicit && LEGACY_ESCALATE_RE.test(text)) {
      kind = 'escalate'
      explicit = true
      text = text.replace(LEGACY_ESCALATE_RE, '')
    }
    return { ts: e.ts, kind, text, explicit }
  })
}

/**
 * Estado atual do card derivado do log: o kind da entrada mais recente que
 * declarou um explicitamente.
 *
 * Uma resolução do PM é mais nova que a escalação que a motivou, então ela
 * naturalmente ganha e o card sai da inbox. `null` = nada foi declarado, o que
 * vale para todo card existente hoje.
 */
export function lastExplicitLogKind(agentLog: string): LogKind | null {
  const entries = parseLogEntries(agentLog)
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (e.explicit) return e.kind
  }
  return null
}
