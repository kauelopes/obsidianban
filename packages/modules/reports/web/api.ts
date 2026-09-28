import type { ModuleHost } from '@obsidiankan/module-sdk/web'
import type {
  GenerateRequest,
  ReportListResponse,
  ReportMarkdownResponse,
  ReportMeta,
  ReportOptions,
  ReportStatus,
} from '../server/api-types.js'

export type Result<T> = { ok: true; data: T } | { ok: false; error: string }

export const STATUS_LABEL: Record<ReportStatus, string> = {
  queued: 'na fila',
  collecting: 'coletando dados',
  analyzing: 'analisando (IA)',
  rendering: 'gerando documento',
  done: 'pronto',
  failed: 'falhou',
}

/** Chamadas às rotas do módulo. Nenhuma lança: erro vira `{ ok: false }` legível. */
export class ReportsApi {
  constructor(private readonly host: ModuleHost) {}

  options(): Promise<Result<ReportOptions>> {
    return this.json('/options')
  }

  async list(project?: string): Promise<Result<ReportMeta[]>> {
    const qs = project ? `?project=${encodeURIComponent(project)}` : ''
    const res = await this.json<ReportListResponse>(`/${qs}`)
    return res.ok ? { ok: true, data: res.data.reports } : res
  }

  generate(req: GenerateRequest): Promise<Result<ReportMeta>> {
    return this.json('/', { method: 'POST', body: JSON.stringify(req) })
  }

  get(id: string): Promise<Result<ReportMeta>> {
    return this.json(`/${encodeURIComponent(id)}`)
  }

  async markdown(id: string): Promise<Result<string>> {
    const res = await this.json<ReportMarkdownResponse>(`/${encodeURIComponent(id)}/markdown`)
    return res.ok ? { ok: true, data: res.data.markdown } : res
  }

  rerenderPdf(id: string): Promise<Result<ReportMeta>> {
    return this.json(`/${encodeURIComponent(id)}/pdf`, { method: 'POST', body: '{}' })
  }

  async remove(id: string): Promise<Result<void>> {
    const res = await this.json<unknown>(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
    return res.ok ? { ok: true, data: undefined } : res
  }

  async pdf(id: string): Promise<Result<{ blob: Blob; filename: string }>> {
    try {
      const res = await this.host.api.fetch(`/${encodeURIComponent(id)}/pdf`)
      if (!res.ok) return { ok: false, error: describe(await res.json().catch(() => null), res.status) }
      const cd = res.headers.get('content-disposition') ?? ''
      const star = /filename\*=UTF-8''([^;]+)/.exec(cd)
      const plain = /filename="([^"]+)"/.exec(cd)
      const filename = star ? decodeURIComponent(star[1]!) : (plain?.[1] ?? `${id}.pdf`)
      return { ok: true, data: { blob: await res.blob(), filename } }
    } catch (err) {
      return { ok: false, error: offline(err) }
    }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<Result<T>> {
    try {
      const res = await this.host.api.fetch(path, init)
      const body = await res.json().catch(() => null)
      if (!res.ok) return { ok: false, error: describe(body, res.status) }
      return { ok: true, data: body as T }
    } catch (err) {
      return { ok: false, error: offline(err) }
    }
  }
}

function describe(body: unknown, status: number): string {
  if (status === 403) return 'sem permissão: gerar e apagar relatórios exige token de pm ou manager'
  if (status === 404 && !body) return 'módulo de relatórios fora do ar (desativado?)'
  const b = (body ?? {}) as Record<string, unknown>
  const code = typeof b['error'] === 'string' ? b['error'] : `erro ${status}`
  const extra = ['hint', 'field', 'expected']
    .filter((k) => typeof b[k] === 'string')
    .map((k) => `${k}: ${String(b[k])}`)
  return extra.length ? `${code} (${extra.join(', ')})` : code
}

function offline(err: unknown): string {
  return `não foi possível falar com o servidor (${err instanceof Error ? err.message : String(err)})`
}

/** Salva um Blob com o nome sugerido — o PDF sai como download, não aba nova. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** YYYY-MM-DD no fuso do navegador. */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function fmtDateBr(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}/${m}/${y}`
}
