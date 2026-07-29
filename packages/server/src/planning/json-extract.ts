/**
 * Extrai o primeiro objeto JSON balanceado de um texto de LLM. Tolera cercas
 * de código (```json … ```) e prosa antes/depois do objeto. Lança Error com
 * mensagem específica — usada no retry corretivo da mesma sessão.
 */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)```/g, '$1').trim()
  const candidate = firstBalancedObject(stripped) ?? firstBalancedObject(text)
  if (candidate === null) {
    throw new Error('nenhum objeto JSON encontrado na resposta')
  }
  try {
    return JSON.parse(candidate)
  } catch (err) {
    throw new Error(`objeto JSON malformado: ${(err as Error).message}`)
  }
}

function firstBalancedObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}
