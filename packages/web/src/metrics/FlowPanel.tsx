import type { FlowMetrics } from '@obsidiankan/types'
import { fmtDay } from '../util/time.js'
import { BarChart, Tile } from './widgets.js'

/**
 * A metade de entrega das Estatísticas.
 *
 * O resto da aba responde "quanto custou"; sem vazão ao lado, esse número não
 * vira decisão — US$ 200 numa semana só é caro ou barato contra o que saiu.
 * Tudo aqui é derivado do audit log, então a série já nasce com o histórico
 * inteiro do vault.
 */
export function FlowPanel({ data }: { data: FlowMetrics }) {
  const { cycle_time_hours: cycle, decision_latency_hours: latency, rework } = data

  // A comparação que revela o gargalo: trabalho de minutos esperando horas por
  // uma decisão. Só vale afirmar com amostra dos dois lados.
  const espera =
    cycle.count > 0 && latency.count > 0 && cycle.p50 > 0 ? latency.p50 / cycle.p50 : null

  const semanas = data.by_week.filter((w) => w.delivered > 0 || w.cost_usd > 0)
  const paradas = data.by_week.filter((w) => w.delivered === 0).length

  return (
    <>
      <section className="chart">
        <p className="label">Fluxo de entrega</p>

        <div className="tiles">
          <Tile
            label="cycle time (mediana)"
            value={fmtHours(cycle.p50, cycle.count)}
            muted={cycle.count === 0}
          />
          <Tile
            label="cycle time (p90)"
            value={fmtHours(cycle.p90, cycle.count)}
            muted={cycle.count === 0}
          />
          <Tile
            label="espera por decisão (mediana)"
            value={fmtHours(latency.p50, latency.count)}
            muted={latency.count === 0}
          />
          <Tile
            label="espera por decisão (p90)"
            value={fmtHours(latency.p90, latency.count)}
            muted={latency.count === 0}
          />
          <Tile
            label="retrabalho"
            value={
              rework.forward + rework.backward > 0
                ? `${(rework.rate * 100).toLocaleString('pt-BR', {
                    minimumFractionDigits: 1,
                    maximumFractionDigits: 1,
                  })}%`
                : 'sem dados'
            }
            muted={rework.forward + rework.backward === 0}
          />
        </div>

        <p className="note">
          <strong>Cycle time</strong> é de <code>in_progress</code> até <code>done</code>;{' '}
          <strong>espera por decisão</strong> é quanto um card fica parado em <code>review</code>{' '}
          até alguém mexer nele. Amostra: {cycle.count} ciclo{cycle.count === 1 ? '' : 's'} e{' '}
          {latency.count} espera{latency.count === 1 ? '' : 's'} concluída
          {latency.count === 1 ? '' : 's'} — card ainda parado em review não entra, porque a espera
          dele não terminou.
          {espera !== null && espera >= 2 && (
            <>
              {' '}
              Hoje a decisão humana demora <strong>{Math.round(espera)}×</strong> o tempo de
              execução: o gargalo do board é a fila de decisão, não a velocidade dos agentes.
            </>
          )}
        </p>
      </section>

      <BarChart
        title="Cards entregues por semana"
        rows={data.by_week.map((w) => ({ label: fmtDay(w.week_start), value: w.delivered }))}
      />

      {paradas > 0 && (
        <p className="note">
          {paradas} semana{paradas === 1 ? '' : 's'} sem nenhuma entrega no período — as barras
          zeradas são reais, não buracos na série.
        </p>
      )}

      <section className="chart">
        <p className="label">Custo por card entregue</p>
        {semanas.length === 0 ? (
          <p className="empty">sem dados neste intervalo</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>semana</th>
                <th className="num">entregues</th>
                <th
                  className="num"
                  title="Preço de lista da API pay-per-token — não é o que você paga num plano de assinatura"
                >
                  custo (US$, lista API)
                </th>
                <th className="num">US$ por card</th>
              </tr>
            </thead>
            <tbody>
              {semanas.map((w) => (
                <tr key={w.week_start}>
                  <td className="mono">{fmtDay(w.week_start)}</td>
                  <td className="num">{w.delivered > 0 ? w.delivered : '—'}</td>
                  <td className="num">{w.cost_usd > 0 ? w.cost_usd.toFixed(2) : '—'}</td>
                  <td className="num">
                    {w.cost_per_card !== null ? w.cost_per_card.toFixed(2) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data.cost_reporting_starts !== null && (
          <p className="note">
            A medição de tokens só começou em {fmtDay(data.cost_reporting_starts)} — antes disso
            nada reportava <code>cost_usd</code>. Semanas anteriores aparecem com “—”, não com
            zero: comparar com elas desenharia uma economia que nunca existiu.
          </p>
        )}
      </section>

      {rework.by_transition.length > 0 && (
        <>
          <BarChart
            title="Retrabalho por transição"
            rows={rework.by_transition.map((t) => ({
              label: `${t.from_status} → ${t.to_status}`,
              value: t.count,
            }))}
          />
          <p className="note">
            Card que volta é trabalho pago duas vezes — e, num board tocado por agentes, é o sinal
            mais direto de card mal especificado ou critério de aceite frouxo. Uma volta de{' '}
            <code>review</code> é rejeição na revisão; de <code>in_progress</code>, geralmente
            desistência ou replanejamento.
          </p>
        </>
      )}

      {data.audit_truncated && (
        <p className="banner">
          O log de auditoria foi lido só até o limite de linhas — os números acima podem estar
          incompletos.
        </p>
      )}
    </>
  )
}

/**
 * Duração legível: minutos abaixo de uma hora (um cycle time de 0,1 h não
 * comunica nada), dias acima de dois. `count === 0` vira "sem dados" para não
 * exibir zero como se fosse medição.
 */
function fmtHours(hours: number, count: number): string {
  if (count === 0) return 'sem dados'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} h`
  return `${(hours / 24).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} dias`
}
