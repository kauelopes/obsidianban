import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GitLifecycleHook } from '../../src/services/git-lifecycle-hook.js'
import { makeManagerClaims } from '../helpers/factories.js'
import type { AuditLogger } from '../../src/audit/logger.js'
import type { ProjectMeta } from '../../src/vault/layout.js'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString()
}

async function commit(name: string, content = name): Promise<void> {
  await fs.writeFile(path.join(repo, name), content)
  git('add', name)
  git('commit', '-m', name)
}

function currentBranch(): string {
  return git('rev-parse', '--abbrev-ref', 'HEAD').trim()
}

function meta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
  return {
    project_id: 'p',
    columns: ['todo', 'done'],
    agent_tokens: [],
    created_at: new Date().toISOString(),
    target_repo: repo,
    git_automation: true,
    ...overrides,
  }
}

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-git-lifecycle-'))
  git('init', '-q', '-b', 'main')
})

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true })
})

describe('GitLifecycleHook', () => {
  it('onStart cria e faz checkout da branch da sprint a partir de main', async () => {
    await commit('a.txt')
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    await hook.onStart({ sprintId: 'sprint-1', project: 'p', meta: meta(), claims: makeManagerClaims() })
    expect(currentBranch()).toBe('sprint/sprint-1')
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ op: 'SPRINT_GIT_BRANCH_CREATED' }))
  })

  it('onStart é idempotente — chamar de novo não perde commits já feitos na branch', async () => {
    await commit('a.txt')
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    const ctx = { sprintId: 'sprint-1', project: 'p', meta: meta(), claims: makeManagerClaims() }
    await hook.onStart(ctx)
    await commit('branch-only.txt')
    await hook.onStart(ctx)
    expect(currentBranch()).toBe('sprint/sprint-1')
    expect(git('log', '--oneline')).toContain('branch-only.txt')
  })

  it('onStart sem branch main não lança, só loga', async () => {
    // repo sem nenhum commit não tem 'main' resolvível ainda
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    await expect(
      hook.onStart({ sprintId: 'sprint-1', project: 'p', meta: meta(), claims: makeManagerClaims() }),
    ).resolves.toBeUndefined()
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('onStart é no-op sem git_automation', async () => {
    await commit('a.txt')
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    await hook.onStart({
      sprintId: 'sprint-1',
      project: 'p',
      meta: meta({ git_automation: false }),
      claims: makeManagerClaims(),
    })
    expect(currentBranch()).toBe('main')
  })

  it('onStart é no-op sem target_repo', async () => {
    await commit('a.txt')
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    await hook.onStart({
      sprintId: 'sprint-1',
      project: 'p',
      meta: meta({ target_repo: undefined }),
      claims: makeManagerClaims(),
    })
    expect(currentBranch()).toBe('main')
  })

  it('onClose commita mudanças pendentes e mescla --no-ff na main', async () => {
    await commit('a.txt')
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    const ctx = { sprintId: 'sprint-1', project: 'p', meta: meta(), claims: makeManagerClaims() }
    await hook.onStart(ctx)
    await fs.writeFile(path.join(repo, 'work.txt'), 'trabalho da sprint')
    await hook.onClose(ctx)
    expect(currentBranch()).toBe('main')
    expect(await fs.readFile(path.join(repo, 'work.txt'), 'utf8')).toBe('trabalho da sprint')
    expect(git('status', '--porcelain')).toBe('')
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ op: 'SPRINT_GIT_MERGED' }))
  })

  it('onClose em conflito aborta o merge, loga e não lança', async () => {
    await commit('shared.txt', 'original')
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    const ctx = { sprintId: 'sprint-1', project: 'p', meta: meta(), claims: makeManagerClaims() }
    await hook.onStart(ctx)
    await commit('shared.txt', 'mudança na branch da sprint')

    git('checkout', 'main')
    await commit('shared.txt', 'mudança divergente na main')

    await expect(hook.onClose(ctx)).resolves.toBeUndefined()
    expect(currentBranch()).toBe('main')
    expect(git('status', '--porcelain')).toBe('') // merge abortado — sem estado pendente
    expect(await fs.readFile(path.join(repo, 'shared.txt'), 'utf8')).toBe('mudança divergente na main')
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ op: 'SPRINT_GIT_MERGE_CONFLICT' }))
  })

  it('onClose é no-op se a sprint nunca teve onStart chamado', async () => {
    await commit('a.txt')
    const audit = { log: vi.fn().mockResolvedValue(undefined) } as unknown as AuditLogger
    const hook = new GitLifecycleHook(audit)
    await hook.onClose({ sprintId: 'sprint-nunca-iniciada', project: 'p', meta: meta(), claims: makeManagerClaims() })
    expect(audit.log).not.toHaveBeenCalled()
  })
})
