import { randomBytes } from 'node:crypto'
import { sha256Hex } from './tokens.js'

export interface SessionToken {
  raw: string
  sha256: string
  actor: string
}

/**
 * Token de sessão do navegador local.
 *
 * Vive só em memória: nasce quando o servidor sobe, morre quando ele cai, e
 * nunca é gravado no vault. É essa a diferença para os tokens de agente e de
 * manager — um token que não é persistido não vaza em backup, em sync de nuvem
 * nem em git, e não precisa ser revogado depois.
 *
 * O servidor injeta o valor no index.html que ele mesmo serve, então o SPA
 * recebe sem ninguém colar nada. Continua sendo um Bearer header como qualquer
 * outro, e é isso que importa: uma aba de terceiros não consegue forjar header
 * customizado sem preflight, e o preflight não passa.
 */
export function mintSessionToken(actor = 'human:local-session'): SessionToken {
  const raw = randomBytes(32).toString('base64url')
  return { raw, sha256: sha256Hex(raw), actor }
}
