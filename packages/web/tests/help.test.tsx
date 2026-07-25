import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Help } from '../src/help/Help.js'

describe('Briefing do agente', () => {
  it('cobre as três zonas do card', () => {
    render(<Help />)
    for (const zona of ['# Spec', '# Notes', '# Agent Log']) {
      expect(screen.getByText(zona)).toBeDefined()
    }
  })

  it('ensina a escalar pelo log_kind, não pelo marcador antigo', () => {
    const { container } = render(<Help />)
    const texto = container.textContent ?? ''
    expect(texto).toContain("log_kind: 'escalate'")
    expect(texto).toContain("log_kind: 'pm_resolved'")
    // O marcador só aparece para dizer que não se usa mais.
    expect(texto).toMatch(/Do \*?\*?not\*?\*? write .?\[ESCALATE\]/)
  })

  it('inclui as tools que existem hoje, incluindo as de supervisão', () => {
    const { container } = render(<Help />)
    const texto = container.textContent ?? ''
    for (const tool of [
      'kanban_update_spec',
      'kanban_update_notes',
      'kanban_get_card_history',
      'kanban_list_escalations',
      'kanban_pick_next',
    ]) {
      expect(texto, `faltou ${tool}`).toContain(tool)
    }
  })

  it('não manda o agente inventar contagem de tokens', () => {
    const { container } = render(<Help />)
    expect(container.textContent).toContain('Do not invent these numbers')
  })
})
