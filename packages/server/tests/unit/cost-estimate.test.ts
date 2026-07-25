import { describe, expect, it } from 'vitest'
import { estimateUsd, MODEL_PRICES_USD_PER_TOKEN, providerOf } from '@obsidiankan/types'

/**
 * O custo em USD é ESTIMADO a partir de tokens por modelo. O número medido de
 * verdade é o `total_cost_usd` do harness, que só o sprint workflow vê.
 *
 * A regra que importa aqui: modelo desconhecido devolve null, nunca zero. O
 * servidor grava `human`, `plugin` e `unknown` como modelo, e tratá-los como
 * grátis transformaria "não sei o preço" em "custou nada".
 */
describe('estimateUsd', () => {
  it('multiplica tokens pelo preço do modelo', () => {
    const usd = estimateUsd('claude-opus-4-8', 1_000_000, 1_000_000)
    // 5 de entrada + 25 de saída por milhão.
    expect(usd).toBeCloseTo(30, 6)
  })

  it('devolve null para modelo fora da tabela — não zero', () => {
    for (const m of ['human', 'plugin', 'unknown', 'gpt-9', '']) {
      expect(estimateUsd(m, 100_000, 50_000)).toBeNull()
    }
  })

  it('zero token num modelo conhecido é zero de verdade', () => {
    // Diferente de "não sei": o modelo é conhecido e não gastou nada.
    expect(estimateUsd('claude-opus-4-8', 0, 0)).toBe(0)
  })

  it('a tabela usa preço por token, não por milhão', () => {
    // Um erro de fator de 1e6 aqui viraria uma conta absurda na tela.
    for (const [model, p] of Object.entries(MODEL_PRICES_USD_PER_TOKEN)) {
      expect(p.input, model).toBeLessThan(0.001)
      expect(p.output, model).toBeLessThan(0.001)
      expect(p.output, model).toBeGreaterThanOrEqual(p.input)
    }
  })

  it('bate com o PRICE do sprint-workflow para opus 4.8', () => {
    // sprint-workflow.ts usa { input: 5/1e6, output: 25/1e6 }. As duas tabelas
    // têm de concordar, senão o painel contradiz o log do workflow.
    const p = MODEL_PRICES_USD_PER_TOKEN['claude-opus-4-8']!
    expect(p.input).toBeCloseTo(5 / 1_000_000, 12)
    expect(p.output).toBeCloseTo(25 / 1_000_000, 12)
  })
})

/**
 * O agrupamento por provedor é heurística de EXIBIÇÃO sobre uma string livre.
 * O que importa travar: pseudo-modelos nunca ganham bandeira de provedor real.
 */
describe('providerOf', () => {
  it('claude-* é anthropic', () => {
    expect(providerOf('claude-opus-4-8')).toBe('anthropic')
    expect(providerOf('claude-haiku-4-5')).toBe('anthropic')
  })

  it('gpt-*, codex-* e oN são openai', () => {
    for (const m of ['gpt-5.1', 'gpt-5.2-codex', 'codex-mini', 'o3', 'o4-mini']) {
      expect(providerOf(m), m).toBe('openai')
    }
  })

  it('pseudo-modelos e desconhecidos são other', () => {
    for (const m of ['human', 'plugin', 'unknown', 'gemini-2', 'obsidian', '']) {
      expect(providerOf(m), m).toBe('other')
    }
  })
})
