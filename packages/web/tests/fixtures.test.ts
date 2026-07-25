import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KanbanClient } from '../src/api/client.js'
import addToSprintJson from './fixtures/add_to_sprint.json'
import archiveProjectJson from './fixtures/archive_project.json'
import createAgentTokenJson from './fixtures/create_agent_token.json'
import getSprintJson from './fixtures/get_sprint.json'
import metricsEmptyJson from './fixtures/metrics_empty.json'
import metricsPopulatedJson from './fixtures/metrics_populated.json'
import moveBetweenSprintsJson from './fixtures/move_between_sprints.json'
import setProjectRepoJson from './fixtures/set_project_repo.json'

/**
 * Estes testes casam os tipos do cliente com JSON REAL, capturado por curl de
 * um servidor rodando contra uma cópia do test-vault e gravado em
 * tests/fixtures/.
 *
 * Existem por um motivo específico: as três fases anteriores da migração
 * quebraram porque a suposição sobre a resposta foi escrita na assinatura do
 * método em vez de conferida contra o servidor. Um teste com corpo inventado à
 * mão reproduz o mesmo erro — ele confirma a crença em vez de confrontá-la.
 * Estes só passam se a forma gravada continuar sendo a forma tipada.
 */
const FIXTURES: Record<string, unknown> = {
  add_to_sprint: addToSprintJson,
  archive_project: archiveProjectJson,
  create_agent_token: createAgentTokenJson,
  get_sprint: getSprintJson,
  metrics_empty: metricsEmptyJson,
  metrics_populated: metricsPopulatedJson,
  move_between_sprints: moveBetweenSprintsJson,
  set_project_repo: setProjectRepoJson,
}

function fixture(name: string): unknown {
  const f = FIXTURES[name]
  if (f === undefined) throw new Error(`fixture ausente: ${name}`)
  return f
}

let respond: (url: string) => { status: number; body: unknown }

beforeEach(() => {
  respond = () => ({ status: 200, body: {} })
  vi.stubGlobal('fetch', async (url: string) => {
    const r = respond(String(url))
    return {
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response
  })
})

afterEach(() => vi.unstubAllGlobals())

const client = new KanbanClient({ token: 'tok' })

describe('formas capturadas do servidor', () => {
  it('get_sprint aninha os agregados em `aggregates`, não no topo', async () => {
    const raw = fixture('get_sprint')
    respond = () => ({ status: 200, body: raw })

    const res = await client.getSprint({ sprint_id: 'sprint-dwcX7M4Z' })
    if (!res.ok) throw new Error('esperava ok')

    // Se algum dia isso for achatado no servidor, este teste quebra em vez de
    // a UI mostrar undefined silenciosamente.
    const a = res.data.aggregates
    expect(a).toBeDefined()
    expect(res.data.sprint.id).toBe('sprint-dwcX7M4Z')
    expect(res.data.project).toBe('teste')

    // Invariantes, não números mágicos: as contagens por status somam o total,
    // e o total casa com o array de cards. Assim o teste sobrevive a uma nova
    // captura do fixture e continua pegando um agregado quebrado.
    expect(a.cards_done + a.cards_in_progress + a.cards_todo + a.cards_other).toBe(a.cards_total)
    expect(res.data.cards).toHaveLength(a.cards_total)
    // Custo zerado é o estado real: os agentes não reportam tokens.
    expect(a.total_input_tokens).toBe(0)
    expect(a.total_output_tokens).toBe(0)
    // `aggregates` não vaza para o topo.
    expect((res.data as unknown as Record<string, unknown>)['cards_total']).toBeUndefined()
  })

  it('add_to_sprint devolve failed[] com objetos, não com ids', async () => {
    const raw = fixture('add_to_sprint')
    respond = () => ({ status: 200, body: raw })

    const res = await client.addToSprint({
      sprint_id: 'sprint-T10Ls7lu',
      card_ids: ['card-NOPE0001', 'card-ZqL78oc6'],
    })
    if (!res.ok) throw new Error('esperava ok')

    expect(res.data.failed).toEqual([{ card_id: 'card-NOPE0001', reason: 'not_found' }])
    expect(res.data.updated).toEqual(['card-ZqL78oc6'])
    // `added` e `updated` não são sinônimos: no momento da captura o card já
    // pertencia a outra sprint, então ele foi *alterado* e não *adicionado*.
    // `added` fica reservado para card que não tinha sprint nenhuma.
    expect(res.data.added).toEqual([])
    expect(res.data.moved_to_todo).toEqual([])
    // Sucesso parcial: um card entrou, outro falhou, e a chamada devolveu 200.
    // Quem consome tem de olhar failed[], não só o status.
    expect(res.data.failed).toHaveLength(1)
  })

  it('move_between_sprints tem forma DIFERENTE de add_to_sprint', async () => {
    const raw = fixture('move_between_sprints') as Record<string, unknown>
    respond = () => ({ status: 200, body: raw })

    const res = await client.moveBetweenSprints({
      sprint_id: 'sprint-T10Ls7lu',
      target_sprint_id: 'sprint-dwcX7M4Z',
      card_ids: ['card-NOPE0001', 'card-ZqL78oc6'],
    })
    if (!res.ok) throw new Error('esperava ok')

    expect(res.data.target_sprint_id).toBe('sprint-dwcX7M4Z')
    expect(res.data.updated).toEqual(['card-ZqL78oc6'])
    // Não tem `added` nem `moved_to_todo` — tratar as duas como a mesma forma
    // era o erro fácil aqui.
    expect(raw['added']).toBeUndefined()
    expect(raw['moved_to_todo']).toBeUndefined()
  })

  it('set_project_repo traz workflow_readiness e minta os dois tokens', async () => {
    const raw = fixture('set_project_repo')
    respond = () => ({ status: 200, body: raw })

    const res = await client.setProjectRepo({ project: 'teste', target_repo: '/tmp/x' })
    if (!res.ok) throw new Error('esperava ok')

    const wr = res.data.workflow_readiness
    expect(wr).toBeDefined()
    expect(wr!.target_repo).toBe('/tmp/kanban-teste-repo')
    expect(wr!.skills.length).toBeGreaterThan(0)
    expect(wr!.config_files.length).toBeGreaterThan(0)
    // Estes dois são KANBAN_PM_TOKEN e KANBAN_DEV_TOKEN, a pendência que o
    // usuário não conseguia resolver pela UI.
    expect(wr!.tokens.generated_pm?.agent_type).toBe('pm')
    expect(wr!.tokens.generated_dev?.agent_type).toBe('dev')
    expect(typeof wr!.tokens.generated_dev?.token).toBe('string')
  })

  it('archive_project devolve a forma do projeto, sem target_repo quando não há', async () => {
    const raw = fixture('archive_project') as Record<string, unknown>
    respond = () => ({ status: 200, body: raw })

    const res = await client.archiveProject({ project: 'teste' })
    if (!res.ok) throw new Error('esperava ok')

    expect(res.data.archived).toBe(true)
    expect(res.data.columns).toContain('in_progress')
    // Ausente, não null. Um tipo `target_repo: string | null` passaria a
    // afirmar um campo que não vem.
    expect('target_repo' in raw).toBe(false)
  })

  it('create_agent_token devolve o token bruto uma única vez', async () => {
    const raw = fixture('create_agent_token')
    respond = () => ({ status: 200, body: raw })

    const res = await client.createAgentToken({
      project: 'teste',
      actor: 'fixture-dev',
      agent_type: 'dev',
    })
    if (!res.ok) throw new Error('esperava ok')

    expect(res.data.agent_type).toBe('dev')
    expect(res.data.actor).toBe('fixture-dev')
    expect(res.data.token).toMatch(/^[\w-]{20,}$/)
    expect(res.data.token_id).toBeTruthy()
  })
})

describe('/metrics', () => {
  it('lê a forma populada, com três sufixos de contagem diferentes', async () => {
    const raw = fixture('metrics_populated') as Record<string, Array<Record<string, unknown>>>
    respond = () => ({ status: 200, body: raw })

    const res = await client.getMetrics()
    if (!res.ok) throw new Error('esperava ok')

    expect(res.data.summary.total_ops).toBe(103)
    // by_type usa `ops`, by_operation usa `count`, e by_day não tem contagem
    // nenhuma. Foi conferido no servidor; qualquer suposição de simetria aqui
    // renderiza undefined na tela.
    expect(raw['by_type']![0]!).toHaveProperty('ops')
    expect(raw['by_operation']![0]!).toHaveProperty('count')
    expect(raw['by_day']![0]!).not.toHaveProperty('ops')
    expect(raw['by_day']![0]!).not.toHaveProperty('count')
  })

  it('aceita a resposta totalmente vazia que vem depois de um rebuild do sqlite', async () => {
    // token_log NÃO é reconstruído a partir dos arquivos: apagar db.sqlite
    // zera o histórico de métricas de vez. Este é o estado real de um vault
    // recém-reconciliado, não um caso hipotético.
    respond = () => ({ status: 200, body: fixture('metrics_empty') })

    const res = await client.getMetrics()
    if (!res.ok) throw new Error('esperava ok')

    expect(res.data.summary.total_ops).toBe(0)
    expect(res.data.by_day).toEqual([])
    expect(res.data.by_agent).toEqual([])
  })

  it('monta a query string só com as datas presentes', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      return { status: 200, json: async () => fixture('metrics_empty') } as Response
    })

    await client.getMetrics()
    await client.getMetrics({ from_date: '2026-06-01' })
    await client.getMetrics({ from_date: '2026-06-01', to_date: '2026-06-30' })

    expect(seen).toEqual([
      '/metrics',
      '/metrics?from_date=2026-06-01',
      '/metrics?from_date=2026-06-01&to_date=2026-06-30',
    ])
  })
})
