import matter from 'gray-matter'
import type { Card } from '../types.js'

const FRONTMATTER_KEYS: ReadonlyArray<keyof Omit<Card, 'body'>> = [
  'id',
  'project',
  'title',
  'status',
  'type',
  'version',
  'position',
  'priority',
  'tags',
  'due_date',
  'assigned_to',
  'owner',
  'agent_notes',
  'total_input_tokens',
  'total_output_tokens',
  'archived',
  'created_at',
  'updated_at',
  'created_by',
  'updated_by',
]

export interface ParsedCardFile {
  data: Record<string, unknown>
  body: string
}

export function parseCardFile(content: string): ParsedCardFile {
  const parsed = matter(content)
  return { data: parsed.data as Record<string, unknown>, body: parsed.content }
}

export function serializeCard(card: Omit<Card, 'body'>, body: string): string {
  const ordered: Record<string, unknown> = {}
  for (const k of FRONTMATTER_KEYS) ordered[k] = card[k]
  return matter.stringify({ content: body }, ordered)
}

export function cardFromFrontmatter(data: Record<string, unknown>): Card {
  return {
    id: requireStr(data, 'id'),
    project: requireStr(data, 'project'),
    title: requireStr(data, 'title'),
    status: requireStr(data, 'status'),
    type: requireStr(data, 'type'),
    version: requireNum(data, 'version'),
    position: requireNum(data, 'position'),
    priority: requirePriority(data),
    tags: requireTags(data),
    due_date: optStr(data, 'due_date'),
    assigned_to: optStr(data, 'assigned_to'),
    owner: optStr(data, 'owner'),
    agent_notes: optStr(data, 'agent_notes'),
    total_input_tokens: numOr(data, 'total_input_tokens', 0),
    total_output_tokens: numOr(data, 'total_output_tokens', 0),
    archived: boolOr(data, 'archived', false),
    created_at: requireStr(data, 'created_at'),
    updated_at: requireStr(data, 'updated_at'),
    created_by: requireStr(data, 'created_by'),
    updated_by: requireStr(data, 'updated_by'),
  }
}

function requireStr(d: Record<string, unknown>, k: string): string {
  const v = d[k]
  if (typeof v !== 'string') throw new Error(`frontmatter field '${k}' must be string`)
  return v
}
function optStr(d: Record<string, unknown>, k: string): string | null {
  const v = d[k]
  if (v == null) return null
  if (typeof v !== 'string') throw new Error(`frontmatter field '${k}' must be string or null`)
  return v
}
function requireNum(d: Record<string, unknown>, k: string): number {
  const v = d[k]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`frontmatter field '${k}' must be number`)
  }
  return v
}
function boolOr(d: Record<string, unknown>, k: string, fallback: boolean): boolean {
  const v = d[k]
  if (v == null) return fallback
  if (typeof v !== 'boolean') throw new Error(`frontmatter field '${k}' must be boolean`)
  return v
}
function numOr(d: Record<string, unknown>, k: string, fallback: number): number {
  const v = d[k]
  if (v == null) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`frontmatter field '${k}' must be number`)
  }
  return v
}
function requirePriority(d: Record<string, unknown>): Card['priority'] {
  const v = d['priority']
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'critical') return v
  throw new Error(`frontmatter 'priority' must be one of low|medium|high|critical`)
}
function requireTags(d: Record<string, unknown>): string[] {
  const v = d['tags']
  if (v == null) return []
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    throw new Error(`frontmatter 'tags' must be string[]`)
  }
  return v as string[]
}
