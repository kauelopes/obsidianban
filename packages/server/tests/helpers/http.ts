export interface HttpResponse {
  status: number
  body: unknown
}

export async function httpPost(
  port: number,
  urlPath: string,
  body: unknown,
  token?: string,
): Promise<HttpResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

export async function httpGet(
  port: number,
  urlPath: string,
  token?: string,
): Promise<HttpResponse> {
  const headers: Record<string, string> = {}
  if (token) headers['authorization'] = `Bearer ${token}`
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, { headers })
  return { status: res.status, body: await res.json().catch(() => null) }
}
