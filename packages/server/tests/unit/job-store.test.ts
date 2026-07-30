import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JobStore } from '../../src/jobs/store.js'
import type { JobRecord } from '../../src/jobs/store.js'
import { createTempVault, cleanupVault } from '../helpers/vault.js'
import type { Paths } from '../../src/config.js'

let paths: Paths
let store: JobStore

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    job_id: 'job-AAAAAAAA',
    card_id: 'card-11111111',
    sprint_id: 'sprint-11111111',
    project: 'proj',
    command: 'echo hi',
    pid: 12345,
    status: 'running',
    started_at: '2026-01-01T00:00:00.000Z',
    last_output_at: '2026-01-01T00:00:00.000Z',
    claimed_by: 'agent:pm',
    ...overrides,
  }
}

beforeEach(async () => {
  paths = await createTempVault()
  store = new JobStore(paths)
})

afterEach(async () => {
  await cleanupVault(paths)
})

describe('JobStore', () => {
  it('save + load fazem roundtrip; o diretório fica em .kanban/jobs', async () => {
    const job = makeJob({ description: 'run tests' })
    await store.save(job)

    const file = path.join(paths.kanbanInternal, 'jobs', `${job.job_id}.json`)
    await expect(fs.stat(file)).resolves.toBeTruthy()

    const loaded = await store.load(job.job_id)
    expect(loaded).toEqual(job)
  })

  it('load de id inexistente ou malformado retorna null sem lançar', async () => {
    expect(await store.load('job-AAAAAAAA')).toBeNull()
    expect(await store.load('../../../etc/passwd')).toBeNull()
  })

  it('escrita é atômica: nenhum .tmp sobra depois do save', async () => {
    const job = makeJob()
    await store.save(job)

    const entries = await fs.readdir(path.join(paths.kanbanInternal, 'jobs'))
    expect(entries).toEqual([`${job.job_id}.json`])
  })

  it('duas escritas concorrentes do mesmo job não colidem no .tmp: ambas completam e nenhum .tmp órfão sobra', async () => {
    const jobId = 'job-AAAAAAAA'
    const throttleWrite = makeJob({ job_id: jobId, last_output_at: '2026-01-01T00:00:10.000Z' })
    const finalizeWrite = makeJob({
      job_id: jobId,
      status: 'succeeded',
      last_output_at: '2026-01-01T00:00:20.000Z',
    })

    await Promise.all([store.save(throttleWrite), store.save(finalizeWrite)])

    const entries = await fs.readdir(path.join(paths.kanbanInternal, 'jobs'))
    expect(entries).toEqual([`${jobId}.json`])

    // O arquivo final é íntegro: reflete exatamente uma das duas escritas
    // (last writer wins), nunca um mix truncado/corrompido das duas.
    const loaded = await store.load(jobId)
    expect([throttleWrite, finalizeWrite]).toContainEqual(loaded)
  })

  it('list retorna todos os jobs e ignora lixo/arquivos corrompidos no diretório', async () => {
    const a = makeJob({ job_id: 'job-AAAAAAAA' })
    const b = makeJob({ job_id: 'job-BBBBBBBB' })
    await store.save(a)
    await store.save(b)
    await fs.writeFile(path.join(paths.kanbanInternal, 'jobs', 'job-CCCCCCCC.json'), '{not json', 'utf8')
    await fs.writeFile(path.join(paths.kanbanInternal, 'jobs', 'lixo.txt'), 'x', 'utf8')

    const listed = await store.list()
    expect(listed.map((j) => j.job_id).sort()).toEqual(['job-AAAAAAAA', 'job-BBBBBBBB'])
  })

  it('list em vault sem diretório jobs retorna vazio', async () => {
    expect(await store.list()).toEqual([])
  })

  it('listByCard filtra por card_id', async () => {
    const a = makeJob({ job_id: 'job-AAAAAAAA', card_id: 'card-11111111' })
    const b = makeJob({ job_id: 'job-BBBBBBBB', card_id: 'card-22222222' })
    await store.save(a)
    await store.save(b)

    const listed = await store.listByCard('card-11111111')
    expect(listed.map((j) => j.job_id)).toEqual(['job-AAAAAAAA'])
  })

  it('listRunning filtra por status running', async () => {
    const running = makeJob({ job_id: 'job-AAAAAAAA', status: 'running' })
    const done = makeJob({ job_id: 'job-BBBBBBBB', status: 'succeeded' })
    await store.save(running)
    await store.save(done)

    const listed = await store.listRunning()
    expect(listed.map((j) => j.job_id)).toEqual(['job-AAAAAAAA'])
  })
})
