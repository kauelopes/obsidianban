import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { TokenValidator } from '../../src/auth/validator.js'
import { mintSessionToken } from '../../src/auth/session.js'
import { createAgentToken } from '../../src/auth/tokens.js'
import { createTempVault, cleanupVault, setupTestProject } from '../helpers/vault.js'
import type { Paths } from '../../src/config.js'

let paths: Paths

beforeEach(async () => {
  paths = await createTempVault()
  await setupTestProject(paths, 'test-project')
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('token de sessão', () => {
  it('vale como manager', async () => {
    const validator = new TokenValidator(paths)
    const session = mintSessionToken()
    validator.useSession(session)

    const result = await validator.validate(session.raw)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.claims.role).toBe('manager')
    expect(result.claims.actor).toBe('human:local-session')
  })

  it('não vale em outro processo — cada boot cunha o seu', async () => {
    const validator = new TokenValidator(paths)
    validator.useSession(mintSessionToken())

    const outro = mintSessionToken()
    const result = await validator.validate(outro.raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('invalid')
  })

  it('sem sessão registrada, o mesmo token é apenas inválido', async () => {
    const session = mintSessionToken()
    const result = await new TokenValidator(paths).validate(session.raw)
    expect(result.ok).toBe(false)
  })

  it('não interfere com token de agente do vault', async () => {
    const validator = new TokenValidator(paths)
    validator.useSession(mintSessionToken())
    const issued = await createAgentToken(paths, 'test-project', 'agent:dev', 'dev')

    const result = await validator.validate(issued.raw)
    expect(result.ok).toBe(true)
    if (!result.ok || result.claims.role !== 'agent') throw new Error('esperava claims de agente')
    expect(result.claims.agent_type).toBe('dev')
    expect(result.claims.project_id).toBe('test-project')
  })

  it('não é gravado no vault', async () => {
    const session = mintSessionToken()
    // O sha nunca deve aparecer em nenhum arquivo de token do vault: é o que
    // garante que ele não sobrevive ao processo nem entra em backup.
    const { promises: fs } = await import('node:fs')
    const meta = await fs.readFile(
      `${paths.kanbanData}/test-project/_meta.json`,
      'utf8',
    )
    expect(meta).not.toContain(session.sha256)
    await expect(fs.access(paths.managerTokens)).rejects.toThrow()
  })
})
