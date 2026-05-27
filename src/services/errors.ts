/**
 * Errors thrown by services that the HTTP layer translates into HTTP status
 * codes. The HTTP dispatcher catches these and renders the appropriate
 * JSON response — handlers themselves never set status codes.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body['error'] === 'string' ? body['error'] : 'http_error')
  }
}

export const notFound = (): HttpError => new HttpError(404, { error: 'not_found' })

export const badRequest = (error: string, extras: Record<string, unknown> = {}): HttpError =>
  new HttpError(400, { error, ...extras })
