import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import { findActiveSprint } from '../vault/layout.js'
import type { Card, Sprint, TokenClaims } from '../types.js'
import { cardFromFrontmatter } from '../cards/serialize.js'
import { HttpError, notFound } from './errors.js'
import { requireString } from './validation.js'
import { readCardFile } from '../vault/card-file.js'

export class CardReader {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
  ) {}

  async requireDevActiveSprint(claims: TokenClaims): Promise<Sprint> {
    if (claims.role !== 'agent' || claims.agent_type !== 'dev') {
      throw new HttpError(500, { error: 'internal', reason: 'requireDevActiveSprint called for non-dev' })
    }
    const active = await findActiveSprint(this.paths, claims.project_id)
    if (!active) {
      throw new HttpError(409, {
        error: 'no_active_sprint',
        reason: 'no sprint is currently active in this project',
        hint: 'PM/manager: start a sprint with kanban_start_sprint. Dev agents must wait for an active sprint before any card operation.',
      })
    }
    return active
  }

  async get(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    if (claims.role === 'agent' && claims.agent_type === 'dev') await this.requireDevActiveSprint(claims)
    const id = requireString(params, 'id')
    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()

    const filePath = path.join(this.paths.kanbanData, row.project, `${row.file_basename}.md`)
    const parsed = await readCardFile(filePath).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound()
      throw err
    })
    const card = cardFromFrontmatter(parsed.data)
    card.body = parsed.body
    card.file_basename = row.file_basename
    return card
  }
}
