import { ModuleHttpError, type ModuleDataApi, type ProjectInfo } from '@obsidiankan/module-sdk'
import type { CardSummary } from '@obsidiankan/types'
import type { GenerateRequest, ReportDocument, ReportParams, ReportTypeInfo } from '../api-types.js'
import { isValidDate } from '../period.js'

export interface BuildContext {
  data: ModuleDataApi
  /** Relógio injetável — testes fixam "hoje". */
  now: Date
}

export interface BuiltReport {
  document: ReportDocument
  /**
   * Os números que sustentam o documento, compactos. É só isto que vai para
   * o LLM: a análise interpreta fatos já calculados, nunca a base bruta.
   */
  facts: Record<string, unknown>
  warnings: string[]
}

export interface ReportTypeDef {
  info: ReportTypeInfo
  /** Valida e normaliza o pedido; lança ModuleHttpError 400/404. */
  resolve(req: GenerateRequest, ctx: BuildContext): Promise<ReportParams>
  build(params: ReportParams, ctx: BuildContext): Promise<BuiltReport>
}

export function badRequest(error: string, extras: Record<string, unknown> = {}): ModuleHttpError {
  return new ModuleHttpError(400, { error, ...extras })
}

export async function requireProject(ctx: BuildContext, name: string | undefined): Promise<ProjectInfo> {
  if (!name) throw badRequest('invalid_field', { field: 'project', hint: 'projeto obrigatório' })
  const p = await ctx.data.getProject(name)
  if (!p) throw new ModuleHttpError(404, { error: 'project_not_found', project: name })
  return p
}

export function requirePeriod(req: GenerateRequest, today: string): { from: string; to: string } {
  const { from, to } = req
  if (!from || !isValidDate(from)) throw badRequest('invalid_field', { field: 'from', expected: 'YYYY-MM-DD' })
  if (!to || !isValidDate(to)) throw badRequest('invalid_field', { field: 'to', expected: 'YYYY-MM-DD' })
  if (from > to) throw badRequest('invalid_period', { hint: 'from depois de to' })
  if (from > today) throw badRequest('invalid_period', { hint: 'período começa no futuro' })
  return { from, to: to > today ? today : to }
}

/** Coluna que conta como entregue: `done` quando existe, senão a última. */
export function doneColumn(columns: readonly string[]): string {
  return columns.includes('done') ? 'done' : (columns.at(-1) ?? 'done')
}

export function cardCost(c: CardSummary): number {
  return c.total_cost_usd ?? 0
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Corta listas longas para o LLM: o prompt carrega amostra, não inventário. */
export function sample<T>(xs: readonly T[], n: number): T[] {
  return xs.slice(0, n)
}
