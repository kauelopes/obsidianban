import type { Card } from '@obsidiankan/types'

/**
 * Ported verbatim from packages/plugin/src/mcp/client.ts. The union is the
 * good part of the plugin's design: no method ever throws, so every caller is
 * forced to handle conflict and offline explicitly instead of discovering them
 * at runtime. The shape is transport-agnostic — only the transport changed.
 */
export interface ConflictError {
  kind: 'conflict'
  status: 409
  message: string
  yourVersion: number
  currentVersion: number
  conflictingFields: string[]
  currentCard: Card
}

export interface ValidationError {
  kind: 'validation'
  status: 400
  message: string
  disallowedFields: string[]
  allowedFields: string[]
}

export interface ServerError {
  kind: 'server'
  status: number
  message: string
  raw?: unknown
}

export interface OfflineError {
  kind: 'offline'
  message: string
  cause: string
}

export type McpError = ConflictError | ValidationError | ServerError | OfflineError

export type McpResult<T> = { ok: true; data: T } | { ok: false; error: McpError }

export function toMcpResult<T>(status: number, body: unknown): McpResult<T> {
  if (status === 200) return { ok: true, data: body as T }
  const b = (body ?? {}) as Record<string, unknown>
  if (status === 409) {
    return {
      ok: false,
      error: {
        kind: 'conflict',
        status: 409,
        message: typeof b['message'] === 'string' ? b['message'] : 'conflict',
        yourVersion: typeof b['your_version'] === 'number' ? b['your_version'] : 0,
        currentVersion: typeof b['current_version'] === 'number' ? b['current_version'] : 0,
        conflictingFields: Array.isArray(b['conflicting_fields'])
          ? (b['conflicting_fields'] as string[])
          : [],
        currentCard: b['current_card'] as Card,
      },
    }
  }
  if (status === 400) {
    return {
      ok: false,
      error: {
        kind: 'validation',
        status: 400,
        message: typeof b['message'] === 'string' ? b['message'] : 'invalid_request',
        disallowedFields: Array.isArray(b['disallowed_fields'])
          ? (b['disallowed_fields'] as string[])
          : [],
        allowedFields: Array.isArray(b['allowed_fields'])
          ? (b['allowed_fields'] as string[])
          : [],
      },
    }
  }
  return {
    ok: false,
    error: {
      kind: 'server',
      status,
      message:
        typeof b['message'] === 'string'
          ? b['message']
          : typeof b['error'] === 'string'
            ? b['error']
            : `http_${status}`,
      raw: b,
    },
  }
}

export function errorText(e: McpError): string {
  switch (e.kind) {
    case 'conflict':
      return `Conflito de versão: você tinha ${e.yourVersion}, o servidor está em ${e.currentVersion}.`
    case 'validation':
      return e.disallowedFields.length > 0
        ? `${e.message} (campos não permitidos: ${e.disallowedFields.join(', ')})`
        : e.message
    case 'offline':
      return `Servidor inacessível: ${e.cause}`
    case 'server':
      return `${e.message} (HTTP ${e.status})`
  }
}
