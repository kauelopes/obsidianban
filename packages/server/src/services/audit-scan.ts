import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import type { AuditEntry } from '@obsidiankan/types'
import { logger } from '../util/logger.js'

/**
 * Leitura streaming do audit log.
 *
 * O arquivo só cresce e não tem índice por timestamp, então toda consulta por
 * janela é uma varredura linear — o teto de linhas é o que garante que a
 * request termina em vez de escalar com a idade do vault. Linha corrompida é
 * pulada (uma escrita truncada não pode invalidar o histórico inteiro) e vault
 * sem log é resposta vazia, não erro.
 */
export async function scanAuditLog(
  logPath: string,
  onEntry: (entry: AuditEntry) => void,
  maxLines: number,
): Promise<{ truncated: boolean }> {
  let truncated = false
  try {
    const rl = createInterface({
      input: createReadStream(logPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    let lines = 0
    for await (const line of rl) {
      if (++lines > maxLines) {
        truncated = true
        rl.close()
        break
      }
      if (!line.trim()) continue
      let entry: AuditEntry
      try {
        entry = JSON.parse(line) as AuditEntry
      } catch {
        continue
      }
      onEntry(entry)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn({ err, logPath }, 'audit scan: failed to read log')
    }
  }
  return { truncated }
}
