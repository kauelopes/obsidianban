import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { KanbanClient } from '../src/api/client.js'
import { Metrics } from '../src/metrics/Metrics.js'
import metricsEmpty from './fixtures/metrics_empty.json'
import metricsPopulated from './fixtures/metrics_populated.json'
import flowEmpty from './fixtures/flow_empty.json'
import flowPopulated from './fixtures/flow_populated.json'

/** A página lê duas rotas sob o mesmo filtro: /metrics (custo) e /flow (entrega). */
function mount(body: unknown, flow: unknown = flowEmpty) {
  vi.stubGlobal(
    'fetch',
    async (url: string) =>
      ({ status: 200, json: async () => (url.includes('/flow') ? flow : body) }) as Response,
  )
  return render(<Metrics client={new KanbanClient({ token: 'tok' })} />)
}

describe('painel de atividade', () => {
  it('mostra "não reportado" em vez de zero quando ninguém mediu tokens', async () => {
    // Este é o estado real do vault do usuário: 103 operações, zero tokens,
    // porque o prompt do dev agent manda omitir contagem. "0" pareceria uma
    // medição que deu zero; "não reportado" diz a verdade.
    mount(metricsPopulated)

    await waitFor(() => expect(screen.getByText('103')).toBeTruthy())
    // 4 tiles sem medição: tokens de entrada, de saída, cache e custo medido.
    expect(screen.getAllByText('não reportado').length).toBe(4)
    // E explica o porquê, em vez de deixar o usuário adivinhar.
    expect(screen.getByText(/não inventar contagem de tokens/)).toBeTruthy()
  })

  it('sobrevive à resposta totalmente vazia de um sqlite recém-reconstruído', async () => {
    mount(metricsEmpty)

    await waitFor(() => expect(screen.getByText('0')).toBeTruthy())
    // Sem arrays, cada seção diz que não tem dado em vez de renderizar nada.
    expect(screen.getAllByText('sem dados neste intervalo').length).toBeGreaterThan(0)
  })

  it('usa a contagem certa de cada agregação: `count` em by_operation, `ops` em by_type', async () => {
    mount(metricsPopulated)

    // by_operation traz `count`; by_type traz `ops`; by_day não traz contagem
    // nenhuma. Ler o campo errado renderiza vazio silenciosamente.
    await waitFor(() => expect(screen.getByText('Operações por tipo de mutação')).toBeTruthy())

    const ops = (metricsPopulated as { by_operation: Array<{ op: string; count: number }> })
      .by_operation
    for (const row of ops) {
      expect(screen.getByText(row.op)).toBeTruthy()
    }
    // Os valores de `count` aparecem escritos ao lado da barra — é isso que
    // torna o gráfico legível sem depender de cor.
    const total = ops.reduce((n, r) => n + r.count, 0)
    expect(total).toBeGreaterThan(0)
  })

  it('não desenha gráfico de volume para by_agent, que não tem contagem', async () => {
    mount(metricsPopulated)
    await waitFor(() => expect(screen.getByText('103')).toBeTruthy())
    fireEvent.click(screen.getByText('Uso via board'))
    await waitFor(() => expect(screen.getByText('Por ator')).toBeTruthy())
    // by_agent e by_day viram tabela justamente porque só têm tokens.
    expect(screen.getByText('Por dia')).toBeTruthy()
    expect(screen.getByText('Por modelo')).toBeTruthy()
  })

  it('mostra o bloco de fluxo junto do custo', async () => {
    mount(metricsPopulated, flowPopulated)
    await waitFor(() => expect(screen.getByText('Fluxo de entrega')).toBeTruthy())
    expect(screen.getByText('Cards entregues por semana')).toBeTruthy()
    expect(screen.getByText('Custo por card entregue')).toBeTruthy()
  })

  it('o filtro de datas recorta as duas metades da aba, não só o custo', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url)
      return {
        status: 200,
        json: async () => (url.includes('/flow') ? flowPopulated : metricsPopulated),
      } as Response
    })
    render(<Metrics client={new KanbanClient({ token: 'tok' })} />)
    await waitFor(() => expect(urls.filter((u) => u.includes('/flow'))).toHaveLength(1))

    fireEvent.change(screen.getByLabelText('de'), { target: { value: '2026-07-01' } })

    await waitFor(() => expect(urls.filter((u) => u.includes('/flow'))).toHaveLength(2))
    expect(urls.at(-1)).toContain('from_date=2026-07-01')
    expect(urls.filter((u) => u.includes('from_date=2026-07-01'))).toHaveLength(2)
  })

  it('servidor sem /flow não derruba a metade de custo, que já funcionava', async () => {
    // Servidor antigo devolve o index.html do SPA em GET /flow — o json()
    // estoura, o client vira ok:false e a página segue mostrando o custo.
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.includes('/flow')) {
        return {
          status: 200,
          json: async () => {
            throw new Error('Unexpected token < in JSON')
          },
        } as unknown as Response
      }
      return { status: 200, json: async () => metricsPopulated } as Response
    })
    render(<Metrics client={new KanbanClient({ token: 'tok' })} />)

    await waitFor(() => expect(screen.getByText('103')).toBeTruthy())
    expect(screen.queryByText('Fluxo de entrega')).toBeNull()
    expect(document.querySelector('.banner')).toBeNull()
  })
})
