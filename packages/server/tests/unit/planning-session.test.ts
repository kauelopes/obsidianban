import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  PlanningSessionStore,
  newPlanningSession,
  isActiveSession,
} from '../../src/planning/session.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import type { Paths } from '../../src/config.js'

let paths: Paths
let store: PlanningSessionStore

beforeEach(async () => {
  paths = await createTempVault()
  store = new PlanningSessionStore(paths)
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('PlanningSessionStore', () => {
  it('save + load fazem roundtrip; o diretório fica em .kanban/planning', async () => {
    const s = newPlanningSession('identity')
    s.answers['identity'] = { name: 'x' }
    await store.save(s)

    const file = path.join(paths.kanbanInternal, 'planning', `${s.session_id}.json`)
    await expect(fs.stat(file)).resolves.toBeTruthy()

    const loaded = await store.load(s.session_id)
    expect(loaded?.answers['identity']).toEqual({ name: 'x' })
    expect(loaded?.status).toBe('awaiting_user')
  })

  it('load de id inexistente ou malformado retorna null sem lançar', async () => {
    expect(await store.load('plan-AAAAAAAA')).toBeNull()
    expect(await store.load('../../../etc/passwd')).toBeNull()
  })

  it('list retorna sessões mais novas primeiro e ignora lixo no diretório', async () => {
    const a = newPlanningSession('identity')
    a.created_at = '2026-01-01T00:00:00.000Z'
    const b = newPlanningSession('identity')
    b.created_at = '2026-02-01T00:00:00.000Z'
    await store.save(a)
    await store.save(b)
    await fs.writeFile(path.join(store.baseDir, 'lixo.txt'), 'x', 'utf8')

    const listed = await store.list()
    expect(listed.map((s) => s.session_id)).toEqual([b.session_id, a.session_id])
  })

  it('list em vault sem diretório planning retorna vazio', async () => {
    expect(await store.list()).toEqual([])
  })

  it('isActiveSession: done/cancelled são terminais, error não', () => {
    const s = newPlanningSession('identity')
    expect(isActiveSession(s)).toBe(true)
    s.status = 'error'
    expect(isActiveSession(s)).toBe(true)
    s.status = 'done'
    expect(isActiveSession(s)).toBe(false)
    s.status = 'cancelled'
    expect(isActiveSession(s)).toBe(false)
  })
})
