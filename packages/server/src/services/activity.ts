import type Database from 'better-sqlite3'
import type { ActivityResponse, ProjectActivity, ProjectDayActivity } from '@obsidiankan/types'
import type { Paths } from '../config.js'
import { listProjectsSafe, loadProjectMetaOrNull } from '../vault/layout.js'
import { SESSION_FLOOR_MS, SESSION_GAP_MS } from '../util/constants.js'
import type { GitActivityService } from './git-activity.js'

const DAY_MS = 24 * 60 * 60 * 1000
const WEEK_MS = 7 * DAY_MS

/**
 * Horas a partir de carimbos de evento: eventos a menos de `gapMs` um do outro
 * formam uma sessão; cada sessão conta pelo menos `floorMs` (um commit isolado
 * não é zero trabalho). É heurística de supervisão, não folha de ponto.
 */
export function clusterSessions(
  timestampsMs: readonly number[],
  gapMs: number = SESSION_GAP_MS,
  floorMs: number = SESSION_FLOOR_MS,
): number {
  if (timestampsMs.length === 0) return 0
  const sorted = [...timestampsMs].sort((a, b) => a - b)
  let total = 0
  let start = sorted[0]!
  let prev = sorted[0]!
  for (const t of sorted.slice(1)) {
    if (t - prev >= gapMs) {
      total += Math.max(prev - start, floorMs)
      start = t
    }
    prev = t
  }
  total += Math.max(prev - start, floorMs)
  return total
}

interface OpRow {
  ts: string
  project: string
}

/**
 * O pulso de trabalho por projeto/dia que a home consome: ops do token_log +
 * commits dos target_repo, em dias do fuso do USUÁRIO (tz_offset do cliente).
 * O /metrics fica em UTC — contabilidade; aqui é gestão, e "ontem à noite"
 * precisa cair em ontem.
 */
export class ActivityService {
  constructor(
    private readonly db: Database.Database,
    private readonly paths: Paths,
    private readonly git: GitActivityService,
  ) {}

  async collect(opts: { days: number; tzOffsetMinutes: number }): Promise<ActivityResponse> {
    const { days, tzOffsetMinutes } = opts
    const now = Date.now()
    const sinceMs = now - days * DAY_MS
    const sinceIso = new Date(sinceMs).toISOString()

    // getTimezoneOffset(): UTC = local + offset, então local = utc − offset.
    const localDate = (ms: number): string =>
      new Date(ms - tzOffsetMinutes * 60_000).toISOString().slice(0, 10)

    const dates: string[] = []
    for (let i = days - 1; i >= 0; i--) dates.push(localDate(now - i * DAY_MS))

    const ops = this.db
      .prepare('SELECT ts, project FROM token_log WHERE ts >= @since')
      .all({ since: sinceIso }) as OpRow[]
    const opsByProject = new Map<string, number[]>()
    for (const row of ops) {
      const ms = Date.parse(row.ts)
      if (Number.isNaN(ms)) continue
      const list = opsByProject.get(row.project)
      if (list) list.push(ms)
      else opsByProject.set(row.project, [ms])
    }

    const names = await listProjectsSafe(this.paths)
    const projects = await Promise.all(
      names.map((name) => this.projectActivity(name, opsByProject.get(name) ?? [], {
        dates,
        sinceIso,
        weekStartMs: now - WEEK_MS,
        localDate,
      })),
    )

    return {
      window_days: days,
      tz_offset_minutes: tzOffsetMinutes,
      projects: projects.filter((p): p is ProjectActivity => p !== null),
    }
  }

  private async projectActivity(
    name: string,
    opTimestamps: number[],
    ctx: {
      dates: string[]
      sinceIso: string
      weekStartMs: number
      localDate: (ms: number) => string
    },
  ): Promise<ProjectActivity | null> {
    const meta = await loadProjectMetaOrNull(this.paths, name)
    if (meta === null || meta.archived === true) return null

    const commits = meta.target_repo
      ? await this.git.commitTimestamps(meta.target_repo, ctx.sinceIso)
      : null

    const byDate = new Map<string, ProjectDayActivity>(
      ctx.dates.map((date) => [date, { date, card_ops: 0, commits: 0 }]),
    )
    for (const ms of opTimestamps) {
      const day = byDate.get(ctx.localDate(ms))
      if (day) day.card_ops++
    }
    for (const ms of commits ?? []) {
      const day = byDate.get(ctx.localDate(ms))
      if (day) day.commits++
    }

    const weekEvents = [...opTimestamps, ...(commits ?? [])].filter(
      (ms) => ms >= ctx.weekStartMs,
    )
    const hours = clusterSessions(weekEvents) / 3_600_000

    return {
      project: name,
      days: ctx.dates.map((d) => byDate.get(d)!),
      estimated_hours_week: Math.round(hours * 10) / 10,
      ...(commits === null ? { repo_unavailable: true } : {}),
    }
  }
}
