import { describe, it, expect } from 'vitest'
import { StubRunner } from '../../src/planning/stub-runner.js'
import { STEPS, buildRefinePrompt, buildRetryPrompt, stepById } from '../../src/planning/steps.js'
import { newPlanningSession } from '../../src/planning/session.js'
import { extractJson } from '../../src/planning/json-extract.js'
import { validateFinalStructure } from '../../src/planning/structure-schema.js'

function makeSession() {
  const s = newPlanningSession('identity')
  s.answers['identity'] = { name: 'projeto-stub-x', description: 'app de teste' }
  return s
}

describe('StubRunner', () => {
  const runner = new StubRunner(0)

  it('toda etapa com prefill produz resposta que passa no parser real', async () => {
    const session = makeSession()
    for (const def of STEPS.filter((s) => s.prefill)) {
      const r = await runner.runTurn(def.buildPrompt(session), null)
      expect(r.ok).toBe(true)
      const parsed = def.parseOutput(extractJson(r.text))
      expect(parsed.screen_payload).toBeTruthy()
      for (const doc of def.kadDocs) {
        expect(parsed.kad_patch?.[doc]).toContain(doc)
      }
    }
  })

  it('sprints_tasks devolve structure válida com o nome do projeto da sessão', async () => {
    const session = makeSession()
    const def = stepById('sprints_tasks')!
    const r = await runner.runTurn(def.buildPrompt(session), null)
    const parsed = def.parseOutput(extractJson(r.text))
    const structure = validateFinalStructure(parsed.structure)
    expect(structure.project.name).toBe('projeto-stub-x')
    expect(structure.epics[0]!.sprints[0]!.tasks.length).toBeGreaterThan(0)
  })

  it('refine responde a etapa nomeada; retry responde a última etapa vista', async () => {
    const session = makeSession()
    const def = stepById('communication')!
    const refined = await runner.runTurn(buildRefinePrompt(session, def, 'setas erradas'), 'stub-session')
    expect(refined.ok).toBe(true)
    expect(def.parseOutput(extractJson(refined.text)).screen_payload).toBeTruthy()

    const retried = await runner.runTurn(buildRetryPrompt(def, 'json inválido'), 'stub-session')
    expect(retried.ok).toBe(true)
    expect(def.parseOutput(extractJson(retried.text)).screen_payload).toBeTruthy()
  })

  it('turnos custam zero e não somam tokens', async () => {
    const session = makeSession()
    const r = await runner.runTurn(stepById('scope')!.buildPrompt(session), null)
    expect(r.usage).toEqual({ input: 0, output: 0, usd: 0 })
  })
})
