// Exercises the pure metrics render helpers.
import { formatInt, lastDays } from '../plugin/src/view/metrics-render.js'

function pass(msg: string): void {
  console.log(`PASS|${msg}`)
}
function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

function main(): void {
  expect(formatInt(0) === '0', 'formatInt(0) = "0"')
  expect(formatInt(1234) === '1,234', `formatInt(1234) = "1,234" (got ${formatInt(1234)})`)
  expect(formatInt(1000000) === '1,000,000', `formatInt(1M) = "1,000,000"`)
  pass('formatInt() uses thousand separators')

  const rows = Array.from({ length: 45 }, (_, i) => ({ date: `2026-04-${String(i + 1).padStart(2, '0')}` }))
  const last30 = lastDays(rows, 30)
  expect(last30.length === 30, `lastDays returns 30 (got ${last30.length})`)
  expect(last30[0]!.date === '2026-04-16', `first of last 30 is 2026-04-16 (got ${last30[0]?.date})`)
  expect(last30[29]!.date === '2026-04-45', `last entry preserved (got ${last30[29]?.date})`)
  pass('lastDays() slices tail correctly')

  const small = [{ date: 'a' }, { date: 'b' }]
  const all = lastDays(small, 30)
  expect(all.length === 2, 'lastDays with fewer rows than N returns all')
  pass('lastDays() handles N > length')
}

try {
  main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
