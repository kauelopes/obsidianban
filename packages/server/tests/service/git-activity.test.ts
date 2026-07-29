import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GitActivityService } from '../../src/services/git-activity.js'

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

async function commit(name: string): Promise<void> {
  await fs.writeFile(path.join(repo, name), name)
  git('add', name)
  git('commit', '-m', name)
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-git-'))
  git('init', '-q')
})

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('GitActivityService', () => {
  it('lê epoch ms dos commits desde a data pedida', async () => {
    await commit('a.txt')
    await commit('b.txt')
    const svc = new GitActivityService()
    const ts = await svc.commitTimestamps(repo, '2020-01-01T00:00:00Z')
    expect(ts).toHaveLength(2)
    for (const t of ts!) {
      expect(t).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'))
      expect(t).toBeLessThanOrEqual(Date.now() + 1000)
    }
  })

  it('diretório inexistente vira null, não erro', async () => {
    const svc = new GitActivityService()
    expect(await svc.commitTimestamps('/nao/existe/nada', '2020-01-01T00:00:00Z')).toBeNull()
  })

  it('diretório que não é repo git vira null', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-notgit-'))
    try {
      const svc = new GitActivityService()
      expect(await svc.commitTimestamps(dir, '2020-01-01T00:00:00Z')).toBeNull()
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('dentro do TTL responde do cache — commit novo não aparece', async () => {
    await commit('a.txt')
    const svc = new GitActivityService()
    const first = await svc.commitTimestamps(repo, '2020-01-01T00:00:00Z')
    expect(first).toHaveLength(1)
    await commit('b.txt')
    const second = await svc.commitTimestamps(repo, '2020-01-01T00:00:00Z')
    expect(second).toHaveLength(1)
  })

  it('mudar o since invalida o cache', async () => {
    await commit('a.txt')
    const svc = new GitActivityService()
    expect(await svc.commitTimestamps(repo, '2020-01-01T00:00:00Z')).toHaveLength(1)
    expect(await svc.commitTimestamps(repo, '2099-01-01T00:00:00Z')).toHaveLength(0)
  })
})
