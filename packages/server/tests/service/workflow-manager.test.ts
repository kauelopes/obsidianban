import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SSEEventBus } from '../../src/server/sse.js'
import {
  WorkflowManager,
  loadWorkflowConfig,
  type WorkflowConfig,
} from '../../src/services/workflow-runner.js'
import { pathsFor } from '../../src/config.js'
import type { SSEEvent } from '@obsidiankan/types'

let dir: string
let repo: string
let logDir: string
let events: SSEEvent[]
let sse: SSEEventBus

// Os overrides de ambiente têm precedência sobre o settings.local.json — para
// os testes serem determinísticos, ambos saem do ambiente do processo.
const ENV_KEYS = ['KANBAN_PM_TOKEN', 'KANBAN_DEV_TOKEN'] as const
let savedEnv: Record<string, string | undefined>

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'obsidiankan-wf-'))
  repo = path.join(dir, 'repo')
  logDir = path.join(dir, 'logs')
  await fs.mkdir(repo, { recursive: true })
  events = []
  sse = new SSEEventBus()
  vi.spyOn(sse, 'emit').mockImplementation((e: SSEEvent) => events.push(e))
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})

async function writeTokens(): Promise<void> {
  const p = path.join(repo, '.claude', 'settings.local.json')
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(
    p,
    JSON.stringify({ env: { KANBAN_TOKEN: 'pm-token', KANBAN_DEV_TOKEN: 'dev-token' } }),
    'utf8',
  )
}

async function writeScript(body: string): Promise<string> {
  const p = path.join(dir, 'workflow.mjs')
  await fs.writeFile(p, body, 'utf8')
  return p
}

function manager(scriptPath: string): WorkflowManager {
  const cfg: WorkflowConfig = {
    scriptPath,
    logDir,
    autoLaunch: false,
    kanbanUrl: 'http://127.0.0.1:9375',
  }
  return new WorkflowManager(cfg, sse, pathsFor(dir))
}

function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const timer = setInterval(() => {
      if (pred()) {
        clearInterval(timer)
        resolve()
      } else if (Date.now() - t0 > ms) {
        clearInterval(timer)
        reject(new Error('waitFor timeout'))
      }
    }, 25)
  })
}

describe('loadWorkflowConfig', () => {
  const paths = pathsFor('/tmp/vault')

  it('sempre retorna config; WORKFLOW_ENABLED controla só o auto-launch', () => {
    const cfg = loadWorkflowConfig({}, paths)
    expect(cfg.autoLaunch).toBe(false)
    expect(cfg.scriptPath.endsWith(path.join('scripts', 'sprint-workflow.ts'))).toBe(true)
    expect(cfg.logDir).toBe(path.join('/tmp/vault', '.kanban', 'workflow-logs'))
    expect(cfg.kanbanUrl).toBe('http://127.0.0.1:9375')
  })

  it('respeita os overrides de ambiente', () => {
    const cfg = loadWorkflowConfig(
      {
        WORKFLOW_ENABLED: 'true',
        WORKFLOW_SCRIPT_PATH: '/x/wf.ts',
        WORKFLOW_LOG_DIR: '/x/logs',
        MCP_HTTP_PORT: '9999',
      },
      paths,
    )
    expect(cfg).toEqual({
      autoLaunch: true,
      scriptPath: '/x/wf.ts',
      logDir: '/x/logs',
      kanbanUrl: 'http://127.0.0.1:9999',
    })
  })
})

describe('WorkflowManager', () => {
  it('executa o script, rastreia o ciclo e emite os eventos SSE', async () => {
    await writeTokens()
    const script = await writeScript(`
      console.log('token pm:', process.env.KANBAN_PM_TOKEN)
      console.log('token dev:', process.env.KANBAN_DEV_TOKEN)
      console.log('url:', process.env.KANBAN_URL)
      console.log('hello from workflow')
    `)
    const m = manager(script)

    const view = await m.start('sprint-01', 'proj', repo)
    expect(view.status).toBe('running')
    expect(view.pid).toBeTypeOf('number')
    expect(events.map((e) => e.type)).toContain('WORKFLOW_STARTED')

    await waitFor(() => m.status('sprint-01')?.status === 'exited')
    const done = m.status('sprint-01')!
    expect(done.exit_code).toBe(0)
    expect(done.ended_at).not.toBeNull()
    expect(events.map((e) => e.type)).toContain('WORKFLOW_EXITED')

    // stdout foi para o log; os tokens vieram do settings.local.json do repo.
    await waitFor(() => events.some((e) => e.type === 'WORKFLOW_EXITED'))
    const log = await m.readLog('sprint-01', 0)
    expect(log.data).toContain('hello from workflow')
    expect(log.data).toContain('token pm: pm-token')
    expect(log.data).toContain('token dev: dev-token')
    expect(log.data).toContain('url: http://127.0.0.1:9375')
    expect(log.size).toBeGreaterThan(0)

    // Leitura incremental: a partir de size não há dado novo.
    const tail = await m.readLog('sprint-01', log.size)
    expect(tail.data).toBe('')
    expect(tail.size).toBe(log.size)
  })

  it('recusa segunda execução em paralelo no mesmo projeto', async () => {
    await writeTokens()
    const script = await writeScript(`setTimeout(() => {}, 30000)`)
    const m = manager(script)
    await m.start('sprint-01', 'proj', repo)
    await expect(m.start('sprint-01', 'proj', repo)).rejects.toMatchObject({ status: 409 })
    await expect(m.start('sprint-02', 'proj', repo)).rejects.toMatchObject({ status: 409 })
    m.stop('sprint-01')
    await waitFor(() => m.status('sprint-01')?.status !== 'running')
  })

  it('stop mata o processo e marca stopped', async () => {
    await writeTokens()
    const script = await writeScript(`setTimeout(() => {}, 30000)`)
    const m = manager(script)
    await m.start('sprint-01', 'proj', repo)
    m.stop('sprint-01')
    await waitFor(() => m.status('sprint-01')?.status === 'stopped')
    const exited = events.find((e) => e.type === 'WORKFLOW_EXITED')
    expect(exited?.payload).toMatchObject({ sprint_id: 'sprint-01', status: 'stopped' })
  })

  it('requestGracefulStop sinaliza só o processo (SIGUSR1), não mata na hora', async () => {
    await writeTokens()
    // Simula o contrato real de sprint-workflow.ts: instala seu próprio
    // handler de SIGUSR1 (terminando a "rodada" e saindo sozinho pouco
    // depois) em vez de depender do default do Node p/ SIGUSR1 sem handler
    // (que ativa o inspector, não mata nem ignora o processo).
    const script = await writeScript(`
      process.on('SIGUSR1', () => setTimeout(() => process.exit(0), 50))
      setTimeout(() => {}, 30000)
    `)
    const m = manager(script)
    await m.start('sprint-01', 'proj', repo)
    // Dá tempo do processo filho de fato registrar seu handler de SIGUSR1
    // antes de mandarmos o sinal — sem isso, mandar o sinal na primeira
    // fração de ms após o spawn corre contra o V8 ainda inicializando, e cai
    // no comportamento default do Node p/ SIGUSR1 sem handler (inspector),
    // não no exit esperado. Mesma folga que existe na prática (ninguém clica
    // "Parar" no primeiro milissegundo de um workflow real).
    await new Promise((resolve) => setTimeout(resolve, 150))

    const view = m.requestGracefulStop('sprint-01')
    expect(view.stopping_gracefully).toBe(true)
    expect(m.status('sprint-01')?.status).toBe('running') // não mata na hora

    await waitFor(() => m.status('sprint-01')?.status === 'exited')
    expect(m.status('sprint-01')?.exit_code).toBe(0)
  })

  it('requestGracefulStop é idempotente e reflete no status()', async () => {
    await writeTokens()
    const script = await writeScript(`setTimeout(() => {}, 30000)`)
    const m = manager(script)
    await m.start('sprint-01', 'proj', repo)

    m.requestGracefulStop('sprint-01')
    m.requestGracefulStop('sprint-01')
    expect(m.status('sprint-01')?.stopping_gracefully).toBe(true)

    m.stop('sprint-01')
    await waitFor(() => m.status('sprint-01')?.status === 'stopped')
  })

  it('requestGracefulStop recusa quando não há execução rodando', async () => {
    const m = manager(path.join(dir, 'x.mjs'))
    await expect(() => m.requestGracefulStop('nope')).toThrowError(
      expect.objectContaining({ status: 404 }),
    )
  })

  it('tokens do settings do repo vencem o ambiente do servidor', async () => {
    // Regressão: um placeholder herdado do shell que lançou o servidor não pode
    // sobrepor os tokens reais provisionados no repo alvo.
    process.env['KANBAN_PM_TOKEN'] = 'REPLACE_WITH_MANAGER_TOKEN'
    process.env['KANBAN_DEV_TOKEN'] = 'REPLACE_WITH_DEV_TOKEN'
    await writeTokens()
    const script = await writeScript(`
      console.log('pm=' + process.env.KANBAN_PM_TOKEN, 'dev=' + process.env.KANBAN_DEV_TOKEN)
    `)
    const m = manager(script)
    await m.start('sprint-01', 'proj', repo)
    await waitFor(() => m.status('sprint-01')?.status === 'exited')
    const log = await m.readLog('sprint-01', 0)
    expect(log.data).toContain('pm=pm-token dev=dev-token')
  })

  it('sem tokens em lugar nenhum, o readiness check os provisiona automaticamente antes do start', async () => {
    // start() agora roda checkWorkflowReadiness antes de resolveTokens — o
    // caso "tokens ausentes" se autocura em vez de falhar com 400.
    const script = await writeScript(`
      console.log('pm=' + process.env.KANBAN_PM_TOKEN, 'dev=' + process.env.KANBAN_DEV_TOKEN)
    `)
    const m = manager(script)
    await m.start('sprint-01', 'proj', repo)
    await waitFor(() => m.status('sprint-01')?.status === 'exited')
    const log = await m.readLog('sprint-01', 0)
    expect(log.data).toMatch(/pm=\S+ dev=\S+/)
    expect(log.data).not.toContain('undefined')

    const settings = JSON.parse(
      await fs.readFile(path.join(repo, '.claude', 'settings.local.json'), 'utf8'),
    ) as { env: { KANBAN_TOKEN: string; KANBAN_DEV_TOKEN: string } }
    expect(settings.env.KANBAN_TOKEN).toBeTruthy()
    expect(settings.env.KANBAN_DEV_TOKEN).toBeTruthy()
  })

  it('falha com 400 quando o target_repo não existe', async () => {
    const script = await writeScript(`console.log('nope')`)
    const m = manager(script)
    await expect(m.start('sprint-01', 'proj', path.join(dir, 'missing'))).rejects.toMatchObject({
      status: 400,
    })
  })

  it('script quebrado termina como failed', async () => {
    await writeTokens()
    const script = await writeScript(`process.exit(2)`)
    const m = manager(script)
    await m.start('sprint-01', 'proj', repo)
    await waitFor(() => m.status('sprint-01')?.status === 'failed')
    expect(m.status('sprint-01')?.exit_code).toBe(2)
  })

  it('readLog de sprint desconhecida (sem log em disco) é 404', async () => {
    const m = manager(path.join(dir, 'x.mjs'))
    await expect(m.readLog('nope', 0)).rejects.toMatchObject({ status: 404 })
  })

  it('readLog serve o log do disco mesmo sem run em memória (pós-restart)', async () => {
    await fs.mkdir(logDir, { recursive: true })
    await fs.writeFile(path.join(logDir, 'sprint-old.log'), 'linha antiga\n', 'utf8')
    const m = manager(path.join(dir, 'x.mjs'))
    const log = await m.readLog('old', 0)
    expect(log.run).toBeNull()
    expect(log.data).toBe('linha antiga\n')
  })

  it('recusa sprint_id com caracteres de path', async () => {
    const m = manager(path.join(dir, 'x.mjs'))
    await expect(m.start('../etc', 'proj', repo)).rejects.toMatchObject({ status: 400 })
    await expect(m.readLog('a/b', 0)).rejects.toMatchObject({ status: 400 })
  })

  describe('setOnFinished', () => {
    it('dispara o hook com a view final após saída normal', async () => {
      await writeTokens()
      const script = await writeScript(`console.log('ok')`)
      const m = manager(script)
      const seen: string[] = []
      m.setOnFinished((view) => seen.push(view.status))

      await m.start('sprint-01', 'proj', repo)
      await waitFor(() => m.status('sprint-01')?.status === 'exited')
      expect(seen).toEqual(['exited'])
    })

    it('dispara o hook também quando o processo é parado via stop()', async () => {
      await writeTokens()
      const script = await writeScript(`setTimeout(() => {}, 30000)`)
      const m = manager(script)
      const seen: string[] = []
      m.setOnFinished((view) => seen.push(view.status))

      await m.start('sprint-01', 'proj', repo)
      m.stop('sprint-01')
      await waitFor(() => m.status('sprint-01')?.status === 'stopped')
      expect(seen).toEqual(['stopped'])
    })

    it('um hook que lança não impede o finalize de completar', async () => {
      await writeTokens()
      const script = await writeScript(`console.log('ok')`)
      const m = manager(script)
      m.setOnFinished(() => {
        throw new Error('boom')
      })

      await m.start('sprint-01', 'proj', repo)
      await waitFor(() => m.status('sprint-01')?.status === 'exited')
      expect(m.status('sprint-01')?.exit_code).toBe(0)
    })
  })

  describe('currentPhase', () => {
    it('sem log em disco, fase é idle e sem atividade', async () => {
      const m = manager(path.join(dir, 'x.mjs'))
      expect(await m.currentPhase('nope')).toEqual({
        phase: 'idle',
        lastActivityAt: null,
        lastTool: null,
      })
    })

    it('detecta fase dev quando o marcador de início é o mais recente', async () => {
      await fs.mkdir(logDir, { recursive: true })
      await fs.writeFile(
        path.join(logDir, 'sprint-s1.log'),
        '▶ TRIAGE(llm): 2 ambiguous card(s)\n◀ TRIAGE(llm) done\n▶ DEV: working up to 3 card(s)\n',
        'utf8',
      )
      const m = manager(path.join(dir, 'x.mjs'))
      const { phase, lastActivityAt } = await m.currentPhase('s1')
      expect(phase).toBe('dev')
      expect(lastActivityAt).not.toBeNull()
    })

    it('detecta fase triage quando o marcador de início é o mais recente', async () => {
      await fs.mkdir(logDir, { recursive: true })
      await fs.writeFile(
        path.join(logDir, 'sprint-s2.log'),
        '▶ DEV: working up to 3 card(s)\n◀ DEV done — in=1 out=1\n▶ TRIAGE(llm): 1 ambiguous card(s)\n',
        'utf8',
      )
      const m = manager(path.join(dir, 'x.mjs'))
      expect((await m.currentPhase('s2')).phase).toBe('triage')
    })

    it('fase idle quando o último marcador é de término', async () => {
      await fs.mkdir(logDir, { recursive: true })
      await fs.writeFile(
        path.join(logDir, 'sprint-s3.log'),
        '▶ DEV: working up to 3 card(s)\n◀ DEV done — in=1 out=1\n',
        'utf8',
      )
      const m = manager(path.join(dir, 'x.mjs'))
      expect((await m.currentPhase('s3')).phase).toBe('idle')
    })

    it('lastTool aponta a tool em voo dentro de um round dev', async () => {
      await fs.mkdir(logDir, { recursive: true })
      await fs.writeFile(
        path.join(logDir, 'sprint-s4.log'),
        '[2026-01-01T00:00:00.000Z] ▶ DEV: working up to 3 card(s)\n' +
          '[2026-01-01T00:00:01.000Z]   ▶ tool: kanban_claim_card(card_id=card-1)\n' +
          '[2026-01-01T00:00:02.000Z]   ◀ tool: kanban_claim_card\n' +
          '[2026-01-01T00:00:03.000Z]   ▶ tool: Bash(command=pnpm test)\n',
        'utf8',
      )
      const m = manager(path.join(dir, 'x.mjs'))
      const { phase, lastTool } = await m.currentPhase('s4')
      expect(phase).toBe('dev')
      expect(lastTool).toEqual({ name: 'Bash', at: '2026-01-01T00:00:03.000Z', status: 'running' })
    })

    it('lastTool continua apontando a última chamada mesmo depois de ela fechar', async () => {
      await fs.mkdir(logDir, { recursive: true })
      await fs.writeFile(
        path.join(logDir, 'sprint-s5.log'),
        '[2026-01-01T00:00:00.000Z] ▶ DEV: working up to 3 card(s)\n' +
          '[2026-01-01T00:00:01.000Z]   ▶ tool: Bash(command=pnpm test)\n' +
          '[2026-01-01T00:00:05.000Z]   ◀ tool: Bash\n',
        'utf8',
      )
      const m = manager(path.join(dir, 'x.mjs'))
      const { lastTool } = await m.currentPhase('s5')
      expect(lastTool).toEqual({ name: 'Bash', at: '2026-01-01T00:00:05.000Z', status: 'done' })
    })

    it('lastTool reporta status error quando a chamada falhou', async () => {
      await fs.mkdir(logDir, { recursive: true })
      await fs.writeFile(
        path.join(logDir, 'sprint-s7.log'),
        '[2026-01-01T00:00:00.000Z] ▶ DEV: working up to 3 card(s)\n' +
          '[2026-01-01T00:00:01.000Z]   ▶ tool: kanban_move_card(id=card-1, to_status=done)\n' +
          '[2026-01-01T00:00:02.000Z]   ◀ tool: kanban_move_card (erro)\n',
        'utf8',
      )
      const m = manager(path.join(dir, 'x.mjs'))
      const { lastTool } = await m.currentPhase('s7')
      expect(lastTool).toEqual({ name: 'kanban_move_card', at: '2026-01-01T00:00:02.000Z', status: 'error' })
    })

    it('não reporta tool "running" fantasma fora da fase dev (round já terminou)', async () => {
      await fs.mkdir(logDir, { recursive: true })
      await fs.writeFile(
        path.join(logDir, 'sprint-s6.log'),
        '[2026-01-01T00:00:00.000Z] ▶ DEV: working up to 3 card(s)\n' +
          '[2026-01-01T00:00:01.000Z]   ▶ tool: Bash(command=pnpm test)\n' +
          '[2026-01-01T00:00:05.000Z] ◀ DEV done — in=1 out=1\n', // round fechou sem "◀ tool:" — ex. crash
        'utf8',
      )
      const m = manager(path.join(dir, 'x.mjs'))
      const result = await m.currentPhase('s6')
      expect(result.phase).toBe('idle')
      expect(result.lastTool).toBeNull()
    })
  })
})
