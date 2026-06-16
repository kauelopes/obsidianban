import type { Card, Sprint, AgentToken, ManagerToken } from '../../src/types.js'

export function makeCard(overrides: Partial<Card> = {}): Omit<Card, 'body'> {
  return {
    id: 'card-testcard1',
    project: 'test-project',
    title: 'Test Card',
    status: 'todo',
    type: 'task',
    version: 1,
    position: 1000,
    priority: 'medium',
    tags: [],
    due_date: null,
    assigned_to: null,
    owner: null,
    agent_notes: null,
    total_input_tokens: 0,
    total_output_tokens: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_by: 'agent:pm-agent',
    updated_by: 'agent:pm-agent',
    archived: false,
    sprint_id: 'sprint-test001',
    blocked_by: [],
    file_basename: 'test-card',
    ...overrides,
  }
}

export function makeSprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-test001',
    name: 'Sprint 1',
    goal: null,
    created_at: '2026-01-01T00:00:00.000Z',
    started_at: null,
    ended_at: null,
    status: 'planning',
    ...overrides,
  }
}

export function makeManagerClaims(): ManagerToken {
  return { role: 'manager', actor: 'human:manager' }
}

export function makeAgentClaims(overrides: Partial<AgentToken> = {}): AgentToken {
  return {
    role: 'agent',
    project_id: 'test-project',
    actor: 'agent:pm-agent',
    agent_type: 'pm',
    ...overrides,
  }
}

export function makeDevClaims(overrides: Partial<AgentToken> = {}): AgentToken {
  return makeAgentClaims({ agent_type: 'dev', actor: 'agent:dev-agent', ...overrides })
}
