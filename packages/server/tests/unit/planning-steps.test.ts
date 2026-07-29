import { describe, it, expect } from 'vitest'
import { STEPS, stepById, nextStep, buildRefinePrompt, buildRetryPrompt } from '../../src/planning/steps.js'
import { newPlanningSession } from '../../src/planning/session.js'
import { validateFinalStructure } from '../../src/planning/structure-schema.js'

describe('sequência de etapas', () => {
  it('começa em identity (form, sem prefill, com tela estática) e termina em review', () => {
    expect(STEPS[0]!.id).toBe('identity')
    expect(STEPS[0]!.prefill).toBe(false)
    expect(STEPS[0]!.staticPayload).toBeDefined()
    expect(STEPS[STEPS.length - 1]!.id).toBe('review')
  })

  it('todas as demais etapas têm prefill', () => {
    for (const s of STEPS.slice(1)) expect(s.prefill).toBe(true)
  })

  it('nextStep percorre a sequência e devolve null no fim', () => {
    expect(nextStep('identity')?.id).toBe('project_type')
    expect(nextStep('review')).toBeNull()
    expect(stepById('nope')).toBeNull()
  })
})

describe('buildPrompt', () => {
  it('primeiro turno inclui o briefing; turnos seguintes só o estado', () => {
    const session = newPlanningSession('identity')
    session.answers['identity'] = { name: 'meu-app', description: 'um app' }
    const scope = stepById('scope')!
    const first = scope.buildPrompt(session)
    expect(first).toContain('arquiteto de planejamento')
    expect(first).toContain('meu-app')

    session.claude_session_id = 'sess-123'
    const later = scope.buildPrompt(session)
    expect(later).not.toContain('arquiteto de planejamento')
    expect(later).toContain('meu-app')
  })

  it('sprints_tasks pede o campo structure no contrato', () => {
    const session = newPlanningSession('identity')
    const prompt = stepById('sprints_tasks')!.buildPrompt(session)
    expect(prompt).toContain('"structure"')
  })

  it('telas diagram levam as regras de sintaxe mermaid em prefill, refine e retry', () => {
    const session = newPlanningSession('identity')
    const rule = 'aspas duplas'
    for (const id of ['domain_model', 'communication'] as const) {
      const def = stepById(id)!
      expect(def.buildPrompt(session)).toContain(rule)
      expect(buildRefinePrompt(session, def, 'setas erradas')).toContain(rule)
      expect(buildRetryPrompt(def, 'json inválido')).toContain(rule)
    }
    expect(stepById('scope')!.buildPrompt(session)).not.toContain(rule)
  })

  it('refine mantém a etapa e inclui o feedback; retry inclui o erro de validação', () => {
    const session = newPlanningSession('identity')
    const diagram = stepById('domain_model')!
    expect(buildRefinePrompt(session, diagram, 'faltou a entidade User')).toContain(
      'faltou a entidade User',
    )
    expect(buildRetryPrompt(diagram, 'mermaid vazio')).toContain('mermaid vazio')
  })
})

describe('parseOutput por tipo de tela', () => {
  it('form aceita fields válidos e recusa shapes errados', () => {
    const scope = stepById('scope')!
    const ok = scope.parseOutput({
      screen_payload: { fields: [{ id: 'positive_scope', label: 'Escopos positivos', value: 'x' }] },
      kad_patch: { vision: '# Visão' },
    })
    expect(ok.kad_patch?.vision).toBe('# Visão')
    expect(() => scope.parseOutput({ screen_payload: { fields: [] } })).toThrow(/fields/)
    expect(() => scope.parseOutput({ screen_payload: { fields: [{ id: 1 }] } })).toThrow(/id e label/)
  })

  it('choice exige question e ao menos 2 options', () => {
    const t = stepById('project_type')!
    expect(() =>
      t.parseOutput({ screen_payload: { question: 'q', options: [{ id: 'a', label: 'A' }] } }),
    ).toThrow(/2 opções/)
  })

  it('diagram exige mermaid não-vazio', () => {
    const d = stepById('domain_model')!
    expect(() => d.parseOutput({ screen_payload: { mermaid: '  ' } })).toThrow(/mermaid/)
    const ok = d.parseOutput({ screen_payload: { mermaid: 'classDiagram\n A --> B' } })
    expect(ok.screen_payload).toMatchObject({ mermaid: expect.stringContaining('classDiagram') })
  })

  it('kad_patch recusa doc desconhecido', () => {
    const c = stepById('roadmap')!
    expect(() =>
      c.parseOutput({ screen_payload: { markdown: 'ok' }, kad_patch: { blog: 'x' } }),
    ).toThrow(/desconhecido/)
  })

  it('sprints_tasks carrega structure adiante', () => {
    const s = stepById('sprints_tasks')!
    const out = s.parseOutput({
      screen_payload: { markdown: '## plano' },
      structure: { project: { name: 'x' }, epics: [] },
    })
    expect(out.structure).toBeDefined()
  })
})

describe('validateFinalStructure', () => {
  const valid = {
    project: { name: 'meu-app', target_repo: '/tmp/repo' },
    goals: [{ title: 'MVP no ar', target_date: '2026-09-01' }],
    epics: [
      {
        name: 'Fundação',
        objective: 'Base do sistema',
        sprints: [
          {
            name: 'Sprint 1',
            goal: 'Esqueleto',
            tasks: [{ title: 'Criar projeto', type: 'task', body: '# Spec\nfazer', priority: 'high' }],
          },
        ],
      },
    ],
  }

  it('aceita estrutura válida e normaliza', () => {
    const s = validateFinalStructure(valid)
    expect(s.epics[0]!.sprints[0]!.tasks[0]!.title).toBe('Criar projeto')
  })

  it('erros apontam o caminho do campo', () => {
    expect(() => validateFinalStructure({ ...valid, project: { name: 'com espaço' } })).toThrow(
      /project\.name/,
    )
    expect(() => validateFinalStructure({ ...valid, epics: [] })).toThrow(/^epics/)
    const badTask = structuredClone(valid) as Record<string, unknown>
    ;(badTask as typeof valid).epics[0]!.sprints[0]!.tasks[0]!.type = 'epic' as 'task'
    expect(() => validateFinalStructure(badTask)).toThrow(/epics\[0\]\.sprints\[0\]\.tasks\[0\]\.type/)
  })

  it('goals com target_date inválida falham com caminho', () => {
    expect(() =>
      validateFinalStructure({ ...valid, goals: [{ title: 'x', target_date: 'amanhã' }] }),
    ).toThrow(/goals\[0\]\.target_date/)
  })
})
