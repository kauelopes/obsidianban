import { promises as fs } from 'node:fs'
import { WORKFLOW_LOG_CHUNK_MAX } from './constants.js'

export interface LogSlice {
  /** Tamanho total do arquivo em bytes no momento da leitura. */
  size: number
  /** Conteúdo a partir do offset pedido (limitado a `maxBytes`). */
  data: string
}

/**
 * Leitura incremental de um arquivo de log por offset — extraída de
 * `WorkflowManager.readLog` para ser reusada pelo JobManager (Task 4).
 * Devolve `null` quando o arquivo não existe (o chamador decide o que isso
 * significa: 404, run em memória sem log ainda, etc.).
 */
export async function readLogSlice(
  logPath: string,
  offset: number,
  maxBytes: number = WORKFLOW_LOG_CHUNK_MAX,
): Promise<LogSlice | null> {
  const stat = await fs.stat(logPath).catch(() => null)
  if (!stat) return null

  const size = stat.size
  const from = Math.min(Math.max(0, offset), size)
  const length = Math.min(size - from, maxBytes)
  let data = ''
  if (length > 0) {
    const fh = await fs.open(logPath, 'r')
    try {
      const buf = Buffer.alloc(length)
      await fh.read(buf, 0, length, from)
      data = buf.toString('utf8')
    } finally {
      await fh.close()
    }
  }
  return { size: from + length, data }
}
