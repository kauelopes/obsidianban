import { describe, it, expect } from 'vitest'
import { sprintStepById } from '../../src/sprint-planning/steps.js'

describe('etapa tasks — parseOutput (parseTaskList)', () => {
  it('deriva screen_payload.tasks com ids sequenciais a partir de structure.tasks', () => {
    const def = sprintStepById('tasks')!
    const raw = {
      screen_payload: { intro: 'contexto' },
      structure: {
        name: 'Sprint X',
        goal: 'entregar y',
        tasks: [
          { title: 'Uma', type: 'task' },
          { title: 'Duas', type: 'bug', priority: 'high', tags: ['x'] },
        ],
      },
    }
    const out = def.parseOutput(raw)
    expect(out.screen_payload).toEqual({
      intro: 'contexto',
      tasks: [
        { id: 't-0', title: 'Uma', type: 'task' },
        { id: 't-1', title: 'Duas', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
    expect(out.structure).toEqual({
      name: 'Sprint X',
      goal: 'entregar y',
      tasks: [
        { title: 'Uma', type: 'task' },
        { title: 'Duas', type: 'bug', priority: 'high', tags: ['x'] },
      ],
    })
  })

  it('rejeita quando structure está ausente', () => {
    const def = sprintStepById('tasks')!
    expect(() => def.parseOutput({ screen_payload: {} })).toThrow('structure ausente')
  })

  it('rejeita structure inválida (tasks vazio)', () => {
    const def = sprintStepById('tasks')!
    expect(() =>
      def.parseOutput({
        screen_payload: {},
        structure: { name: 'x', goal: 'y', tasks: [] },
      }),
    ).toThrow(/structure inválida/)
  })

  it('a etapa tasks usa a tela task_list', () => {
    expect(sprintStepById('tasks')!.screen).toBe('task_list')
  })
})
