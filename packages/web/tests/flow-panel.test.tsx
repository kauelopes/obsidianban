import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { FlowMetrics } from '@obsidiankan/types'
import { FlowPanel } from '../src/metrics/FlowPanel.js'
import flowPopulated from './fixtures/flow_populated.json'
import flowEmpty from './fixtures/flow_empty.json'

const POPULATED = flowPopulated as unknown as FlowMetrics
const EMPTY = flowEmpty as unknown as FlowMetrics

function mount(data: FlowMetrics) {
  return render(<FlowPanel data={data} />)
}

describe('FlowPanel', () => {
  it('mostra duração em minutos abaixo de uma hora e em horas acima', () => {
    mount(POPULATED)
    // 0,1 h de cycle time vira "6 min" — "0,1 h" não comunica nada.
    expect(screen.getByText('6 min')).toBeTruthy()
    expect(screen.getByText('4,5 h')).toBeTruthy()
    expect(screen.getByText('13,7 h')).toBeTruthy()
  })

  it('aponta o gargalo quando a decisão demora múltiplos do trabalho', () => {
    mount(POPULATED)
    expect(screen.getByText(/gargalo do board é a fila de decisão/)).toBeTruthy()
    expect(screen.getByText(/6×/)).toBeTruthy()
  })

  it('não afirma gargalo sem amostra dos dois lados', () => {
    mount(EMPTY)
    expect(screen.queryByText(/gargalo do board/)).toBeNull()
  })

  it('sem amostra, diz "sem dados" em vez de exibir zero como medição', () => {
    const { container } = mount(EMPTY)
    expect(container.querySelectorAll('.tile-value.muted').length).toBeGreaterThanOrEqual(5)
    expect(screen.getAllByText('sem dados').length).toBeGreaterThan(0)
  })

  it('mostra a taxa de retrabalho e as transições que a compõem', () => {
    mount(POPULATED)
    expect(screen.getByText('7,0%')).toBeTruthy()
    expect(screen.getByText('review → todo')).toBeTruthy()
    expect(screen.getByText('in_progress → todo')).toBeTruthy()
  })

  it('conta as semanas sem entrega em vez de escondê-las', () => {
    mount(POPULATED)
    expect(screen.getByText(/2 semanas sem nenhuma entrega/)).toBeTruthy()
  })

  it('semana sem medição de custo mostra travessão, não zero', () => {
    const { container } = mount(POPULATED)
    const linhas = [...container.querySelectorAll('.table tbody tr')].map((tr) =>
      [...tr.querySelectorAll('td')].map((td) => td.textContent),
    )
    // 08/06: 10 entregues, custo e US$/card sem medição.
    expect(linhas[0]).toEqual(['08/06', '10', '—', '—'])
    // 27/07: primeira semana com custo reportado.
    expect(linhas.at(-1)).toEqual(['27/07', '103', '196.53', '1.91'])
  })

  it('avisa desde quando o custo é medido, para não ler queda inexistente', () => {
    mount(POPULATED)
    expect(screen.getByText(/A medição de tokens só começou em/)).toBeTruthy()
  })

  it('avisa quando o log foi truncado', () => {
    mount({ ...POPULATED, audit_truncated: true })
    expect(screen.getByText(/lido só até o limite de linhas/)).toBeTruthy()
  })

  it('sem semanas, a tabela de custo diz que não há dados', () => {
    mount(EMPTY)
    expect(screen.getAllByText('sem dados neste intervalo').length).toBeGreaterThan(0)
  })
})
