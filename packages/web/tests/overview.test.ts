import { describe, expect, it } from 'vitest'
import type { CardSummary, EscalationItem, Sprint } from '@obsidiankan/types'
import {
  buildOverview,
  compareEscalation,
  compareReview,
  mergeCards,
} from '../src/home/overview.js'
import type { ProjectInfo } from '../src/board/useBoard.js'
import getSprintJson from './fixtures/get_sprint.json'

const CARDS = getSprintJson.cards as unknown as CardSummary[]
const SPRINT = getSprintJson.sprint as unknown as Sprint

const PROJECT: ProjectInfo = {
  project: 'teste',
  columns: ['backlog', 'todo', 'in_progress', 'review', 'done'],
  archived: false,
  sprints: [SPRINT],
  goals: [],
}

function esc(cardId: string, project: string): EscalationItem {
  return {
    card_id: cardId,
    project,
    title: 'x',
    status: 'in_progress',
    version: 1,
    priority: 'high',
    assigned_to: null,
    updated_at: '2026-06-01T00:00:00Z',
    escalated_at: null,
    reason: 'bloqueado',
  }
}

describe('buildOverview', () => {
  it('conta cards por status na ordem das colunas do projeto', () => {
    const [ov] = buildOverview(CARDS, [PROJECT], [])
    expect(ov!.project).toBe('teste')
    expect(ov!.statusCounts).toEqual([
      { status: 'backlog', count: 0 },
      { status: 'todo', count: 11 },
      { status: 'in_progress', count: 0 },
      { status: 'review', count: 1 },
      { status: 'done', count: 1 },
    ])
    expect(ov!.total).toBe(13)
  })

  it('deriva o progresso da sprint ativa das contagens client-side', () => {
    const [ov] = buildOverview(CARDS, [PROJECT], [])
    const inSprint = CARDS.filter((c) => c.sprint_id === SPRINT.id)
    expect(ov!.active).not.toBeNull()
    expect(ov!.active!.sprint.id).toBe(SPRINT.id)
    expect(ov!.active!.total).toBe(inSprint.length)
    expect(ov!.active!.done).toBe(inSprint.filter((c) => c.status === 'done').length)
  })

  it('separa cards em review e escalações do projeto certo', () => {
    const review = CARDS.find((c) => c.status === 'review')!
    const [ov] = buildOverview(
      CARDS,
      [PROJECT],
      [esc(review.id, 'teste'), esc('card-outro', 'outro-projeto')],
    )
    expect(ov!.review.map((c) => c.id)).toEqual([review.id])
    expect(ov!.escalations).toHaveLength(1)
    expect(ov!.escalations[0]!.card_id).toBe(review.id)
  })

  it('projeto listado sem nenhum card aparece vazio; cards órfãos inferem projeto', () => {
    const vazio: ProjectInfo = { project: 'aaa-vazio', columns: ['todo'], archived: false, sprints: [], goals: [] }
    const ovs = buildOverview(CARDS, [vazio], [])
    expect(ovs.map((o) => o.project)).toEqual(['aaa-vazio', 'teste'])
    expect(ovs[0]!.total).toBe(0)
    expect(ovs[0]!.lastUpdate).toBeNull()
    // 'teste' não está em projects (token dev) e mesmo assim aparece.
    expect(ovs[1]!.total).toBe(13)
  })

  it('cards arquivados saem das contagens mas não do lastUpdate', () => {
    const archived = { ...CARDS[0]!, id: 'card-arq', archived: true, updated_at: '2027-01-01T00:00:00Z' }
    const [ov] = buildOverview([...CARDS, archived], [PROJECT], [])
    expect(ov!.total).toBe(13)
    expect(ov!.lastUpdate).toBe('2027-01-01T00:00:00Z')
  })

  it('projeto arquivado não vira tile mesmo com cards na janela', () => {
    const arquivado: ProjectInfo = { ...PROJECT, archived: true }
    expect(buildOverview(CARDS, [arquivado], [])).toEqual([])
  })
})

describe('mergeCards', () => {
  it('une por id, com o primeiro argumento ganhando o empate', () => {
    const fresh = { ...CARDS[0]!, title: 'versão do SSE' }
    const stale = { ...CARDS[0]!, title: 'versão do snapshot' }
    const extra = { ...CARDS[1]!, id: 'card-extra01' }
    const merged = mergeCards([fresh], [stale, extra])
    expect(merged.map((c) => c.title)).toContain('versão do SSE')
    expect(merged.map((c) => c.title)).not.toContain('versão do snapshot')
    expect(merged.map((c) => c.id)).toContain('card-extra01')
  })
})

describe('ordenação da fila de decisão', () => {
  it('review: prioridade maior primeiro, empate para quem espera há mais tempo', () => {
    const base = CARDS[0]!
    const cards = [
      { ...base, id: 'a', priority: 'medium' as const, updated_at: '2026-06-01T00:00:00Z' },
      { ...base, id: 'b', priority: 'critical' as const, updated_at: '2026-06-03T00:00:00Z' },
      { ...base, id: 'c', priority: 'medium' as const, updated_at: '2026-05-01T00:00:00Z' },
    ]
    expect([...cards].sort(compareReview).map((c) => c.id)).toEqual(['b', 'c', 'a'])
  })

  it('escalação: a mais antiga primeiro, usando escalated_at quando existe', () => {
    const nova = { ...esc('n', 'p'), escalated_at: '2026-06-10T00:00:00Z' }
    const velha = { ...esc('v', 'p'), escalated_at: null, updated_at: '2026-06-01T00:00:00Z' }
    expect([nova, velha].sort(compareEscalation).map((e) => e.card_id)).toEqual(['v', 'n'])
  })
})
