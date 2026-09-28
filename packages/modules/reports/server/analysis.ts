import type { LlmCompletion, LlmProvider } from '@obsidiankan/module-sdk'
import type { ReportDocument } from './api-types.js'

export const ANALYSIS_SECTIONS = ['Resumo', 'Destaques', 'Riscos', 'Recomendações'] as const

/**
 * O prompt carrega só os fatos já calculados (JSON). A regra central é não
 * inventar número: a análise interpreta, e o documento deixa claro que é
 * interpretação — os números oficiais estão nas tabelas ao lado.
 */
export function buildAnalysisPrompt(doc: Pick<ReportDocument, 'kicker' | 'title' | 'period'>, facts: Record<string, unknown>): string {
  return [
    `Você é um analista de gestão de projetos de software. Escreva a análise do "${doc.kicker}" intitulado "${doc.title}" (período ${doc.period.from} a ${doc.period.to}).`,
    '',
    'Regras:',
    '- Use SOMENTE os fatos do JSON abaixo. Não invente números, datas, nomes nem causas que o JSON não sustente.',
    '- Todo número citado deve aparecer no JSON (pode arredondar). Se um dado não existe, diga que não há dado.',
    '- Português do Brasil, direto, sem jargão de marketing e sem elogios genéricos.',
    `- Responda apenas em Markdown, com exatamente estas seções de nível ###: ${ANALYSIS_SECTIONS.map((s) => `"### ${s}"`).join(', ')}.`,
    '- "Resumo": 2 a 4 frases. "Destaques", "Riscos" e "Recomendações": 2 a 5 bullets cada, concretos e acionáveis.',
    '- No máximo 350 palavras. Sem tabelas, sem blocos de código, sem título de nível # ou ##.',
    '- Não chame ferramentas nem leia arquivos: todo o contexto está aqui.',
    '',
    'Fatos (JSON):',
    '```json',
    JSON.stringify(facts, null, 2),
    '```',
  ].join('\n')
}

/** Tira cerca de código que o modelo às vezes põe em volta da resposta inteira. */
export function cleanAnalysis(text: string): string {
  const t = text.trim()
  const fenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/.exec(t)
  return (fenced ? fenced[1]! : t).trim()
}

export interface AnalysisOutcome {
  ok: boolean
  markdown: string
  error: string | null
  completion: LlmCompletion | null
}

export async function runAnalysis(
  llm: LlmProvider,
  doc: ReportDocument,
  facts: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AnalysisOutcome> {
  const completion = await llm.complete({ prompt: buildAnalysisPrompt(doc, facts), ...(signal ? { signal } : {}) })
  if (!completion.ok) {
    return {
      ok: false,
      markdown: '',
      error: completion.rateLimited ? `limite de uso do LLM atingido: ${completion.error ?? ''}`.trim() : (completion.error ?? 'falha do LLM'),
      completion,
    }
  }
  const markdown = cleanAnalysis(completion.text)
  if (!markdown) return { ok: false, markdown: '', error: 'LLM devolveu resposta vazia', completion }
  return { ok: true, markdown, error: null, completion }
}
