/**
 * "1200" → "1.2K", "3400000" → "3.4M" — contagens grandes (ops, tokens) viram
 * ilegíveis em dígito cheio nos tiles/gráficos da Atividade. Abaixo de 1000
 * cai no `toLocaleString('pt-BR')` normal (separador de milhar continua útil
 * ali, não há o que abreviar).
 */
export function fmtCompact(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  const units: Array<[number, string]> = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'K'],
  ]
  for (const [threshold, suffix] of units) {
    // 0.9995 e não 1: 999_500 arredonda para "1000K" na unidade de baixo, então
    // já entra aqui como "1M".
    if (abs >= threshold * 0.9995) {
      const v = abs / threshold
      const digits = v < 10 ? 1 : 0
      const str = v.toFixed(digits).replace(/\.0$/, '')
      return `${sign}${str}${suffix}`
    }
  }
  return `${sign}${abs.toLocaleString('pt-BR')}`
}
