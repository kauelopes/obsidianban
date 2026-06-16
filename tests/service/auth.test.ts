import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Paths } from '../../src/config.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import { TokenValidator, extractBearer } from '../../src/auth/validator.js'
import {
  createAgentToken,
  createManagerToken,
  revokeAgentToken,
  revokeManagerToken,
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
