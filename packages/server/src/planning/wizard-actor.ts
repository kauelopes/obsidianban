// Modelos conhecidos ganham um rótulo curto; um id desconhecido cai no
// fallback (sem o prefixo "claude-") em vez de travar em cadastro manual.
const KNOWN_MODEL_LABELS: Record<string, string> = {
  'claude-opus-5': 'opus5',
  'claude-sonnet-5': 'sonnet5',
  'claude-fable-5': 'fable5',
  'claude-haiku-4-5-20251001': 'haiku4.5',
}

/**
 * Actor sintético para tudo que um wizard de planejamento materializa: identifica
 * o modelo que gerou o plano em vez do humano que clicou em "finalizar" — quem
 * decidiu o conteúdo foi o modelo. `suffix` diferencia qual wizard (`wizard` =
 * KAD de projeto novo, `sprint-wizard` = criação de sprint num projeto existente).
 */
export function wizardActorTag(modelLabel: string, suffix = 'wizard'): string {
  const short = KNOWN_MODEL_LABELS[modelLabel] ?? modelLabel.replace(/^claude-/, '')
  return `${short}:${suffix}`
}
