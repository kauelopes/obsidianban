/**
 * Widgets de agregação compartilhados entre a Atividade e a Home. Vieram de
 * Metrics.tsx sem mudança de comportamento.
 */

export function Tile({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <strong className={muted ? 'tile-value muted' : 'tile-value'}>{value}</strong>
    </div>
  )
}

/**
 * Barras horizontais, série única.
 *
 * Uma cor só, não uma rampa: o validador do dataviz reprovou a rampa
 * sequencial deste teal — os passos escuros caem abaixo de 3:1 contra a
 * superfície. Série única também dispensa legenda, e cada barra leva o valor
 * escrito, que é o "relief" exigido e torna o gráfico legível sem depender de
 * cor. `<title>` dá tooltip por marca sem uma linha de JS.
 */
export function BarChart({
  title,
  rows,
}: {
  title: string
  rows: Array<{ label: string; value: number }>
}) {
  if (rows.length === 0) {
    return (
      <section className="chart">
        <p className="label">{title}</p>
        <p className="empty">sem dados neste intervalo</p>
      </section>
    )
  }

  const total = rows.reduce((n, r) => n + r.value, 0)

  return (
    <section className="chart">
      <p className="label">{title}</p>
      <ul className="bars">
        {rows.map((r) => {
          // Proporção do TOTAL, não do máximo: normalizar pelo máximo fazia
          // 2 de 5 operações renderem uma barra cheia — escala que mente.
          const pct = total > 0 ? (r.value / total) * 100 : 0
          const share = total > 0 ? Math.round((r.value / total) * 100) : 0
          return (
            <li key={r.label} title={`${r.label}: ${r.value} (${share}% do total)`}>
              <span className="bar-label mono">{r.label}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${pct}%` }} />
              </span>
              <span className="bar-value mono">{r.value.toLocaleString('pt-BR')}</span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function TokenTable({
  title,
  head,
  rows,
}: {
  title: string
  head: string
  rows: Array<{ label: string; input: number; output: number }>
}) {
  return (
    <section className="chart">
      <p className="label">{title}</p>
      {rows.length === 0 ? (
        <p className="empty">sem dados neste intervalo</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{head}</th>
              <th className="num">entrada</th>
              <th className="num">saída</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="mono">{r.label}</td>
                <td className="num">{r.input > 0 ? r.input.toLocaleString('pt-BR') : '—'}</td>
                <td className="num">{r.output > 0 ? r.output.toLocaleString('pt-BR') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
