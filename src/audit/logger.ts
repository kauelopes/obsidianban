import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AuditEntry } from '../types.js'

export class AuditLogger {
  constructor(private readonly logPath: string) {}

  async log(entry: Omit<AuditEntry, 'ts'> & { ts?: string }): Promise<void> {
    const full: AuditEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry }
    await fs.mkdir(path.dirname(this.logPath), { recursive: true })
    await fs.appendFile(this.logPath, JSON.stringify(full) + '\n', 'utf8')
  }
}
