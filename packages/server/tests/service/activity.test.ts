import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { ActivityService } from '../../src/services/activity.js'
import { GitActivityService } from '../../src/services/git-activity.js'
import { loadProjectMeta, saveProjectMeta } from '../../src/vault/layout.js'
import { createTestDb } from '../helpers/db.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'

let paths: Paths
let repo: string

function git(...args: string[]): void {
  execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
}

beforeEach(async () => {
  paths = await createTempVault()
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-act-'))
  git('init', '-q')
})

afterEach(async () => {
  await cleanupVault(paths)
  await fs.rm(repo, { recursive: true, force: true })
})

function seedOp(db: ReturnType<typeof createTestDb>, project: string, ts: string): void {
  db.prepare(
    `INSERT INTO token_log (ts, op, card_id, card_type, actor, model, input_tokens, output_tokens, project)
     VALUES (@ts, 'MOVE', 'card-x', 'task', 'human:kaue', 'human', 0, 0, @project)`,
  ).run({ ts, project })
}

describe('ActivityService.collect', () => {
  it('combina ops e commits por dia local, com dias zerados presentes', async () => {
    const db = createTestDb()
    await setupTestProject(paths, 'alfa')
    const meta = await loadProjectMeta(paths, 'alfa')
    meta.target_repo = repo
    await saveProjectMeta(paths, 'alfa', meta)

    await fs.writeFile(path.join(repo, 'a.txt'), 'a')
    git('add', 'a.txt')
    git('commit', '-m', 'a')

    // Perto de agora, para caber na janela em qualquer hora do dia.
    seedOp(db, 'alfa', new Date(Date.now() - 60_000).toISOString())
    seedOp(db, 'alfa', new Date().toISOString())

    const svc = new ActivityService(db, paths, new GitActivityService())
    const res = await svc.collect({ days: 3, tzOffsetMinutes: 0 })

    expect(res.window_days).toBe(3)
    const alfa = res.projects.find((p) => p.project === 'alfa')!
    expect(alfa.days).toHaveLength(3)
    expect(alfa.repo_unavailable).toBeUndefined()
    const dates = alfa.days.map((d) => d.date)
    expect([...dates].sort()).toEqual(dates)
    expect(alfa.days.reduce((n, d) => n + d.card_ops, 0)).toBe(2)
    expect(alfa.days.reduce((n, d) => n + d.commits, 0)).toBe(1)
    // Eventos em ~1min: uma sessão, pelo menos o piso de 10min.
    expect(alfa.estimated_hours_week).toBeGreaterThan(0)
  })

  it('projeto sem target_repo vem com repo_unavailable e commits zerados', async () => {
    const db = createTestDb()
    await setupTestProject(paths, 'beta')
    const svc = new ActivityService(db, paths, new GitActivityService())
    const res = await svc.collect({ days: 2, tzOffsetMinutes: 0 })
    const beta = res.projects.find((p) => p.project === 'beta')!
    expect(beta.repo_unavailable).toBe(true)
    expect(beta.days.every((d) => d.commits === 0)).toBe(true)
  })

  it('projeto arquivado fica de fora', async () => {
    const db = createTestDb()
    await setupTestProject(paths, 'gama')
    const meta = await loadProjectMeta(paths, 'gama')
    meta.archived = true
    await saveProjectMeta(paths, 'gama', meta)
    const svc = new ActivityService(db, paths, new GitActivityService())
    const res = await svc.collect({ days: 2, tzOffsetMinutes: 0 })
    expect(res.projects).toEqual([])
  })

  it('tz_offset desloca o bucket do dia: o op cai na data LOCAL, não na UTC', async () => {
    const db = createTestDb()
    await setupTestProject(paths, 'alfa')
    const opMs = Date.now()
    seedOp(db, 'alfa', new Date(opMs).toISOString())
    const svc = new ActivityService(db, paths, new GitActivityService())

    for (const offset of [0, 180, -540]) {
      const res = await svc.collect({ days: 2, tzOffsetMinutes: offset })
      const hit = res.projects[0]!.days.find((d) => d.card_ops === 1)
      // Contrato do bucketing: local = utc − offset (getTimezoneOffset).
      const expected = new Date(opMs - offset * 60_000).toISOString().slice(0, 10)
      expect(hit?.date).toBe(expected)
    }
  })
})
