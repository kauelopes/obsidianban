import type { SSEEventType } from '@obsidiankan/types'

export const SSE_EVENT_TYPES: readonly SSEEventType[] = [
  'CARD_CREATED',
  'CARD_UPDATED',
  'CARD_MOVED',
  'CARD_REORDERED',
  'CARD_HUMAN_EDITED',
  'CARD_DELETED',
  'CARD_ARCHIVED',
  'CARD_UNARCHIVED',
  'PROJECT_ARCHIVED',
  'PROJECT_UNARCHIVED',
  'PROJECT_DELETED',
  'SPRINT_CREATED',
  'SPRINT_STARTED',
  'SPRINT_UPDATED',
  'SPRINT_CLOSED',
]

export interface BoardEvent {
  type: SSEEventType
  payload: Record<string, unknown>
}

export type ConnectionState = 'connecting' | 'open' | 'closed'

/**
 * Replaces the plugin's 126-line hand-rolled reconnect loop. EventSource gives
 * automatic retry and Last-Event-ID replay for free, and the server's SSE bus
 * already keeps a 100-event history keyed by that id — so a reconnect resumes
 * rather than dropping board state on the floor.
 */
export function subscribe(
  onEvent: (e: BoardEvent) => void,
  onState?: (s: ConnectionState) => void,
  baseUrl = '',
): () => void {
  const es = new EventSource(`${baseUrl}/events`)

  onState?.('connecting')
  es.onopen = () => onState?.('open')
  es.onerror = () => {
    // EventSource retries on its own; CLOSED means it gave up for good.
    onState?.(es.readyState === EventSource.CLOSED ? 'closed' : 'connecting')
  }

  const listeners: Array<[string, EventListener]> = []
  for (const type of SSE_EVENT_TYPES) {
    const handler: EventListener = (ev) => {
      const data = (ev as MessageEvent).data
      let payload: Record<string, unknown> = {}
      if (typeof data === 'string' && data) {
        try {
          payload = JSON.parse(data) as Record<string, unknown>
        } catch {
          // A malformed frame must not kill the subscription.
          return
        }
      }
      onEvent({ type, payload })
    }
    es.addEventListener(type, handler)
    listeners.push([type, handler])
  }

  return () => {
    for (const [type, handler] of listeners) es.removeEventListener(type, handler)
    es.close()
    onState?.('closed')
  }
}
