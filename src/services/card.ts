import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../config.js'
import type { CardRepository } from '../cards/repository.js'
import type { TokenClaims, Card } from '../types.js'
import { cardFromFrontmatter, parseCardFile } from '../cards/serialize.js'
import { badRequest, notFound } from './errors.js'

/**
 * Mutation entry point for cards. Batch 1 implements only `get_card`; create /
 * update / move / reorder land in Batch 2 and 3. Read isolation:
 *
 *   - agent token: only sees cards in claims.project_id
 *   - manager token: sees any project
 *
 * Cross-project access for agents collapses to 404 (BR-03) — never 403.
 */
export class CardService {
  constructor(
    private readonly paths: Paths,
    private readonly repo: CardRepository,
  ) {}

  async get(params: Record<string, unknown>, claims: TokenClaims): Promise<Card> {
    const id = params['id']
    if (typeof id !== 'string' || id.length === 0) {
      throw badRequest('invalid_field', { field: 'id', expected: 'string' })
    }

    const row = this.repo.findById(id)
    if (!row) throw notFound()
    if (claims.role === 'agent' && row.project !== claims.project_id) throw notFound()

    const filePath = path.join(this.paths.kanbanData, row.project, `${id}.md`)
    const content = await fs.readFile(filePath, 'utf8').catch((err) => {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound()
      throw err
    })
    const parsed = parseCardFile(content)
    const card = cardFromFrontmatter(parsed.data)
    card.body = parsed.body
    return card
  }
}
