export interface SSEFrame {
  id: number
  type: string
  data: unknown
}

/** Parse one SSE block (lines separated by \n, no trailing \n\n). */
export function parseSseBlock(block: string): SSEFrame | null {
  let id: number | null = null
  let type: string | null = null
  let data: unknown = null
  for (const line of block.split('\n')) {
    if (line.startsWith('id: ')) {
      const n = Number(line.slice(4))
      if (Number.isFinite(n)) id = n
    } else if (line.startsWith('event: ')) {
      type = line.slice(7)
    } else if (line.startsWith('data: ')) {
      try {
        data = JSON.parse(line.slice(6))
      } catch {
        // data stays null — frame still fires if type+id are present
      }
    }
  }
  if (type != null && id != null) return { id, type, data }
  return null
}

/**
 * Feed a raw SSE chunk into the running buffer. Returns the updated buffer
 * and any complete frames extracted from it. Pure — no side effects.
 */
export function feedSseChunk(buf: string, chunk: string): { buf: string; frames: SSEFrame[] } {
  buf += chunk
  const frames: SSEFrame[] = []
  let idx: number
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, idx)
    buf = buf.slice(idx + 2)
    const frame = parseSseBlock(block)
    if (frame) frames.push(frame)
  }
  return { buf, frames }
}
