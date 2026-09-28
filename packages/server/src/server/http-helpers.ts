import type { IncomingMessage, ServerResponse } from 'node:http'
import type { TokenClaims } from '@obsidiankan/types'
import type { TokenValidator } from '../auth/validator.js'
import { extractBearer } from '../auth/validator.js'

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

/**
 * Binário (PDF de relatório etc.). `filename` vira Content-Disposition inline:
 * o navegador abre o visualizador e o botão de salvar já sugere o nome.
 */
export function sendFile(
  res: ServerResponse,
  status: number,
  data: Uint8Array,
  contentType: string,
  filename?: string,
): void {
  res.statusCode = status
  res.setHeader('content-type', contentType)
  res.setHeader('content-length', String(data.byteLength))
  if (filename) {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')
    res.setHeader(
      'content-disposition',
      `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
  }
  res.end(data)
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export function isLoopback(addr: string): boolean {
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

/**
 * Loopback ou faixa RFC 1918 (LAN privada: 10/8, 172.16/12, 192.168/16).
 * Node reporta clientes IPv4 como `::ffff:x.x.x.x` quando o servidor escuta
 * em 0.0.0.0 sob socket dual-stack — por isso os dois formatos são checados.
 */
export function isPrivateLan(addr: string): boolean {
  if (isLoopback(addr)) return true
  const v4 = addr.startsWith('::ffff:') ? addr.slice('::ffff:'.length) : addr
  if (v4.startsWith('10.') || v4.startsWith('192.168.')) return true
  const m = /^172\.(\d{1,3})\./.exec(v4)
  if (m) {
    const octet = Number(m[1])
    return octet >= 16 && octet <= 31
  }
  return false
}

/**
 * O header Origin traz esquema + host + porta; o Host, só host + porta. A
 * comparação é entre as duas últimas partes — o esquema não entra porque o
 * servidor é http puro em loopback.
 */
function sameHost(origin: string, host: string | undefined): boolean {
  if (!host) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Recusa requisição que um site de terceiros poderia ter disparado.
 *
 * O servidor escuta em 127.0.0.1, mas isso não protege do navegador: qualquer
 * aba aberta alcança essa porta. O que impede o abuso é o header
 * `Authorization`, que exige preflight e portanto não pode ser forjado
 * cross-origin — só que a defesa inteira estava apoiada nesse detalhe. Estas
 * três checagens tiram a dependência:
 *
 * - `content-type: application/json` é obrigatório. Sem isso, uma página
 *   qualquer manda um POST "simples" com `text/plain`, sem preflight, e o
 *   readJsonBody parseia do mesmo jeito.
 * - `Sec-Fetch-Site` é posto pelo navegador e não é falsificável por script.
 *   Ausente significa cliente não-navegador (curl, agente, SDK) — permitido.
 * - `Origin` cross-origin é recusado por redundância, para navegador antigo
 *   sem Sec-Fetch-Site.
 */
export function rejectUnsafeRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') {
    sendJson(res, 415, {
      error: 'unsupported_media_type',
      hint: 'send content-type: application/json',
    })
    return true
  }

  const fetchSite = req.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    sendJson(res, 403, { error: 'forbidden', reason: 'cross_site' })
    return true
  }

  const origin = req.headers['origin']
  if (typeof origin === 'string' && !sameHost(origin, req.headers.host)) {
    sendJson(res, 403, { error: 'forbidden', reason: 'cross_origin' })
    return true
  }

  return false
}

/** Valida o bearer; em caso de falha já respondeu 401 e devolve null. */
export async function authenticate(
  validator: TokenValidator,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<TokenClaims | null> {
  const bearer = extractBearer(req.headers.authorization)
  const result = await validator.validate(bearer)
  if (!result.ok) {
    const errors = {
      missing: 'missing_token',
      invalid: 'invalid_token',
      revoked: 'revoked_token',
    } as const
    sendJson(res, 401, { error: errors[result.reason] })
    return null
  }
  return result.claims
}
