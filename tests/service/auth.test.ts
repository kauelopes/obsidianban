import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import { TokenValidator, extractBearer } from '../../src/auth/validator.js'
import {
  createAgentToken,
  createManagerToken,
  revokeAgentToken,
  revokeManagerToken,
  listManagerTokens,
  lookupBySha,
  sha256Hex,
} from '../../src/auth/tokens.js'
import { ensureProject } from '../../src/vault/layout.js'

let paths: Paths

beforeEach(async () => {
  paths = await createTempVault()
  await ensureProject(paths, 'test-project')
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('extractBearer', () => {
  it('returns the token from "Bearer <token>" header', () => {
    expect(extractBearer('Bearer mytoken123')).toBe('mytoken123')
  })

  it('is case-insensitive for the Bearer prefix', () => {
    expect(extractBearer('bearer mytoken123')).toBe('mytoken123')
  })

  it('returns undefined for missing header', () => {
    expect(extractBearer(undefined)).toBeUndefined()
  })

  it('returns undefined for malformed header', () => {
    expect(extractBearer('Basic somethingelse')).toBeUndefined()
  })
})

describe('TokenValidator', () => {
  it('returns missing for undefined bearer', async () => {
    const validator = new TokenValidator(paths)
    const result = await validator.validate(undefined)
    expect(result).toEqual({ ok: false, reason: 'missing' })
  })

  it('returns invalid for unknown token', async () => {
    const validator = new TokenValidator(paths)
    const result = await validator.validate('totally-unknown-token')
    expect(result).toEqual({ ok: false, reason: 'invalid' })
  })

  it('validates agent token and returns agent claims', async () => {
    const issued = await createAgentToken(paths, 'test-project', 'agent:pm-agent', 'pm')
    const validator = new TokenValidator(paths)
    const result = await validator.validate(issued.raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.role).toBe('agent')
      expect(result.claims.actor).toBe('agent:pm-agent')
      if (result.claims.role === 'agent') {
        expect(result.claims.project_id).toBe('test-project')
        expect(result.claims.agent_type).toBe('pm')
      }
    }
  })

  it('validates dev agent token with correct agent_type', async () => {
    const issued = await createAgentToken(paths, 'test-project', 'agent:dev-agent', 'dev')
    const validator = new TokenValidator(paths)
    const result = await validator.validate(issued.raw)
    expect(result.ok).toBe(true)
    if (result.ok && result.claims.role === 'agent') {
      expect(result.claims.agent_type).toBe('dev')
    }
  })

  it('validates manager token and returns manager claims', async () => {
    const issued = await createManagerToken(paths, 'human:manager')
    const validator = new TokenValidator(paths)
    const result = await validator.validate(issued.raw)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.role).toBe('manager')
      expect(result.claims.actor).toBe('human:manager')
    }
  })

  it('returns revoked for a revoked agent token', async () => {
    const issued = await createAgentToken(paths, 'test-project', 'agent:pm-agent', 'pm')
    await revokeAgentToken(paths, 'test-project', issued.token_id)
    const validator = new TokenValidator(paths)
    const result = await validator.validate(issued.raw)
    expect(result).toEqual({ ok: false, reason: 'revoked' })
  })

  it('returns revoked for a revoked manager token', async () => {
    const issued = await createManagerToken(paths, 'human:manager')
    await revokeManagerToken(paths, issued.token_id)
    const validator = new TokenValidator(paths)
    const result = await validator.validate(issued.raw)
    expect(result).toEqual({ ok: false, reason: 'revoked' })
  })
})

describe('tokens — gap coverage', () => {
  it('createAgentToken on a non-existent project creates the project via ensureProject', async () => {
    const issued = await createAgentToken(paths, 'brand-new-project', 'agent:x', 'dev')
    expect(issued.token_id).toBeTruthy()
    // Validate the token — validator will find it in the new project's _meta.json
    const validator = new TokenValidator(paths)
    const result = await validator.validate(issued.raw)
    expect(result.ok).toBe(true)
  })

  it('revokeAgentToken on an already-revoked token returns false', async () => {
    const issued = await createAgentToken(paths, 'test-project', 'agent:x', 'pm')
    const first = await revokeAgentToken(paths, 'test-project', issued.token_id)
    expect(first).toBe(true)
    const second = await revokeAgentToken(paths, 'test-project', issued.token_id)
    expect(second).toBe(false)
  })

  it('revokeAgentToken with an unknown tokenId returns false', async () => {
    const result = await revokeAgentToken(paths, 'test-project', 'nonexistent-token-id')
    expect(result).toBe(false)
  })

  it('revokeManagerToken on an already-revoked token returns false', async () => {
    const issued = await createManagerToken(paths, 'human:manager')
    await revokeManagerToken(paths, issued.token_id)
    const second = await revokeManagerToken(paths, issued.token_id)
    expect(second).toBe(false)
  })

  it('lookupBySha returns null for an unknown sha', async () => {
    const result = await lookupBySha(paths, sha256Hex('unknown-token-value'), ['test-project'])
    expect(result).toBeNull()
  })

  it('lookupBySha silently skips a project whose _meta.json is missing', async () => {
    // Create a project directory without writing _meta.json
    const ghostProjectDir = path.join(paths.kanbanData, 'ghost-project')
    await fs.mkdir(ghostProjectDir, { recursive: true })

    await expect(
      lookupBySha(paths, sha256Hex('some-token'), ['ghost-project', 'test-project']),
    ).resolves.toBeNull()
  })

  it('listManagerTokens throws when manager-tokens.json is corrupted JSON', async () => {
    await fs.mkdir(path.dirname(paths.managerTokens), { recursive: true })
    await fs.writeFile(paths.managerTokens, '{broken json', 'utf8')
    await expect(listManagerTokens(paths)).rejects.toThrow()
  })
})

describe('extractBearer — gap coverage', () => {
  it('BEARER uppercase prefix is accepted', () => {
    expect(extractBearer('BEARER mytoken123')).toBe('mytoken123')
  })

  it('double space between Bearer and token: documents actual behavior (token captured with leading space)', () => {
    // The regex is /^Bearer\s+(.+)$/i — \s+ is greedy but (.+) captures the remainder
    // "Bearer  mytoken" → match[1] = "mytoken" because \s+ consumes all leading whitespace
    // This token will then fail SHA lookup (correct behavior), not return undefined
    const result = extractBearer('Bearer  mytoken')
    // \s+ already consumes both spaces, so captured group is just "mytoken"
    expect(result).toBe('mytoken')
  })
})
