import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { ReportDocument, RendererStatus } from './api-types.js'

export const PDF_TIMEOUT_MS = 120_000
const STATUS_TTL_MS = 60_000

/** Tema da marca repassado ao renderer; campos ausentes usam o padrão ObsidianKan. */
export interface ReportTheme {
  brand?: string
  tagline?: string
  site?: string
  footer?: string
  document_type?: string
}

export interface PdfResult {
  ok: boolean
  error: string | null
}

export interface PdfRendererLike {
  status(): Promise<RendererStatus>
  render(doc: ReportDocument, theme: ReportTheme, outPath: string): Promise<PdfResult>
}

/**
 * `renderer/` fica na raiz do pacote. Rodando do fonte (testes) o arquivo está
 * em server/, compilado em dist/server/ — sobe até achar o cli.py.
 */
export function defaultRendererDir(): string {
  const candidates = [path.resolve(__dirname, '..', 'renderer'), path.resolve(__dirname, '..', '..', 'renderer')]
  return candidates.find((d) => existsSync(path.join(d, 'cli.py'))) ?? candidates[0]!
}

/** REPORTS_PYTHON > venv do renderer (make reports-setup) > python3 do PATH. */
export function resolvePython(env: Readonly<Record<string, string | undefined>>, rendererDir: string): string {
  if (env['REPORTS_PYTHON']) return env['REPORTS_PYTHON']
  const venv = path.join(rendererDir, '.venv', 'bin', 'python')
  return existsSync(venv) ? venv : 'python3'
}

/**
 * PDF via Python + WeasyPrint (pipeline copiado do geracao_reports). O Node
 * manda o ReportDocument + tema por stdin; o Python escreve o PDF no caminho
 * pedido. Python ausente ou sem WeasyPrint não é erro do relatório: o
 * Markdown continua valendo e o PDF fica "indisponível" com o motivo.
 */
export class PdfRenderer implements PdfRendererLike {
  private cached: { at: number; value: RendererStatus } | null = null

  constructor(
    private readonly python: string,
    private readonly rendererDir: string,
    private readonly timeoutMs = PDF_TIMEOUT_MS,
  ) {}

  async status(): Promise<RendererStatus> {
    if (this.cached && Date.now() - this.cached.at < STATUS_TTL_MS) return this.cached.value
    const probe = await run(this.python, ['-c', 'import weasyprint, matplotlib; print(weasyprint.__version__)'], '', 20_000)
    const value: RendererStatus = probe.ok
      ? { available: true, python: this.python, reason: null }
      : { available: false, python: this.python, reason: explain(probe) }
    this.cached = { at: Date.now(), value }
    return value
  }

  async render(doc: ReportDocument, theme: ReportTheme, outPath: string): Promise<PdfResult> {
    const st = await this.status()
    if (!st.available) return { ok: false, error: st.reason }
    const cli = path.join(this.rendererDir, 'cli.py')
    const res = await run(this.python, [cli, '--out', outPath], JSON.stringify({ document: doc, theme }), this.timeoutMs)
    if (res.ok) return { ok: true, error: null }
    // Falha de render derruba o cache: pode ter sido o ambiente que mudou.
    this.cached = null
    return { ok: false, error: explain(res) }
  }
}

interface RunResult {
  ok: boolean
  code: number | null
  stderr: string
  spawnError: string | null
  timedOut: boolean
}

function run(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const child = spawn(cmd, args, { env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    const finish = (r: RunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ ok: false, code: null, stderr, spawnError: null, timedOut: true })
    }, timeoutMs)
    child.stderr.on('data', (d) => (stderr += d.toString()))
    child.stdout.on('data', () => {})
    child.on('error', (err) => finish({ ok: false, code: null, stderr, spawnError: err.message, timedOut: false }))
    child.on('close', (code) => finish({ ok: code === 0, code, stderr, spawnError: null, timedOut: false }))
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
}

function explain(r: RunResult): string {
  if (r.spawnError) return `python indisponível (${r.spawnError}) — rode \`make reports-setup\` ou defina REPORTS_PYTHON`
  if (r.timedOut) return 'renderer excedeu o tempo limite'
  const tail = r.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 400)
  if (/No module named '?(weasyprint|matplotlib)/.test(r.stderr)) {
    return `dependências do renderer ausentes (${tail}) — rode \`make reports-setup\``
  }
  return tail || `renderer saiu com código ${r.code}`
}
