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

/**
 * Pulso diário de um projeto: uma coluna por dia, ops de cards embaixo e
 * commits empilhados em cima. Duas tonalidades neutras — cor continua
 * reservada a estado. Escala normalizada pelo MAIOR DIA DO CONJUNTO recebido
 * via `max`, para os sparklines da home serem comparáveis entre projetos; o
 * `<title>` por dia carrega o número exato.
 */
export function Sparkline({
  days,
  max,
}: {
  days: Array<{ date: string; card_ops: number; commits: number }>
  max?: number
}) {
  const peak = Math.max(1, max ?? Math.max(...days.map((d) => d.card_ops + d.commits)))
  const W = 4
  const GAP = 2
  const H = 28
  const width = days.length * (W + GAP) - GAP
  return (
    <svg
      className="sparkline"
      width={width}
      height={H}
      viewBox={`0 0 ${width} ${H}`}
      role="img"
      aria-label={`atividade dos últimos ${days.length} dias`}
    >
      {days.map((d, i) => {
        const total = d.card_ops + d.commits
        const x = i * (W + GAP)
        // Dia com qualquer atividade nunca arredonda para invisível.
        const hOps = d.card_ops > 0 ? Math.max(2, (d.card_ops / peak) * H) : 0
        const hCommits = d.commits > 0 ? Math.max(2, (d.commits / peak) * H) : 0
        return (
          <g key={d.date}>
            <title>{`${d.date}: ${d.card_ops} ops, ${d.commits} commits`}</title>
            {total === 0 && (
              <rect className="spark-idle" x={x} y={H - 1} width={W} height={1} />
            )}
            {hOps > 0 && (
              <rect className="spark-ops" x={x} y={H - hOps} width={W} height={hOps} />
            )}
            {hCommits > 0 && (
              <rect
                className="spark-commits"
                x={x}
                y={H - hOps - hCommits}
                width={W}
                height={hCommits}
              />
            )}
          </g>
        )
      })}
    </svg>
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
