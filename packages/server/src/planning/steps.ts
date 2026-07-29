import type { KadDocId, PlanningSession, StepId } from './session.js'
import { KAD_DOC_IDS } from './session.js'

export type ScreenType = 'form' | 'choice' | 'list' | 'diagram' | 'confirm'

export interface StepOutput {
  screen_payload: unknown
  kad_patch?: Partial<Record<KadDocId, string>>
  /** Presente apenas na etapa sprints_tasks — validada por structure-schema. */
  structure?: unknown
}

export interface StepDef {
  id: StepId
  title: string
  screen: ScreenType
  /** Documentos KAD que esta etapa alimenta. */
  kadDocs: KadDocId[]
  /** true = roda um turno do LLM ANTES de mostrar a tela (pré-preenchimento). */
  prefill: boolean
  /** Tela estática para etapas sem prefill. */
  staticPayload?: unknown
  buildPrompt(session: PlanningSession): string
  /** Valida o JSON do LLM; a mensagem do throw alimenta o retry corretivo. */
  parseOutput(raw: unknown): StepOutput
}

// ── Contratos de payload por tipo de tela ────────────────────────────────────
// A web renderiza exatamente estas formas; o parseOutput garante que o LLM as
// produziu. Respostas humanas (session.answers) seguem convenção própria:
// form → {campo: valor}, choice → {choice}, list → {items}, diagram/confirm →
// {approved: true} (correções passam por planning_refine, não por answers).

const FORM_CONTRACT =
  '{"screen_payload":{"fields":[{"id":"...","label":"...","help":"...(opcional)","value":"...(pré-preenchimento opcional)"}]}'
const CHOICE_CONTRACT =
  '{"screen_payload":{"question":"...","options":[{"id":"...","label":"...","description":"...(opcional)"}],"suggested":"id da opção sugerida (opcional)"}'
const LIST_CONTRACT =
  '{"screen_payload":{"intro":"...(opcional)","items":[{"id":"...","title":"...","detail":"...(opcional)"}]}'
const DIAGRAM_CONTRACT = '{"screen_payload":{"mermaid":"...","caption":"...(opcional)"}'
const CONFIRM_CONTRACT = '{"screen_payload":{"markdown":"..."}'

// Enviada em todo turno de tela diagram (prefill, refine e retry) porque o
// lexer do mermaid quebra com "--", "/", parênteses etc. soltos em rótulos —
// a causa mais comum de diagrama que não renderiza na web.
const MERMAID_RULES =
  ' Regras de sintaxe mermaid: coloque TODO rótulo (de aresta e de nó) que contenha ' +
  'caracteres especiais — "--", "/", "+", parênteses, dois-pontos — entre aspas duplas, ' +
  'ex.: A -- "git log --numstat" --> B e C["taxa (%)"]; nunca use "--" fora de aspas em rótulos.'

function contract(screen: ScreenType, withStructure = false): string {
  const base = {
    form: FORM_CONTRACT,
    choice: CHOICE_CONTRACT,
    list: LIST_CONTRACT,
    diagram: DIAGRAM_CONTRACT,
    confirm: CONFIRM_CONTRACT,
  }[screen]
  const structurePart = withStructure ? ',"structure":{...conforme descrito acima...}' : ''
  return (
    `Responda SOMENTE com um objeto JSON válido, sem cerca de código e sem prosa fora dele, ` +
    `neste formato: ${base},"kad_patch":{"<doc>":"markdown completo atualizado do documento"}${structurePart}}. ` +
    `Em kad_patch, envie a versão COMPLETA e atualizada de cada documento afetado (não um diff); ` +
    `docs possíveis: ${KAD_DOC_IDS.join(', ')}.` +
    (screen === 'diagram' ? MERMAID_RULES : '')
  )
}

const INTRO = `Você é o arquiteto de planejamento do ObsidianKan. Junto com o usuário, você vai construir o KAD (Knowledge Architecture Design) de um projeto novo: um conjunto de documentos markdown (vision, prd, domain_model, architecture, knowledge, features, stories, roadmap) e, ao final, a estrutura de execução (épicos → sprints → tarefas) que agentes de IA usarão para desenvolver o projeto de ponta a ponta.

O processo é um wizard: a cada turno eu te digo o que o usuário respondeu e qual a próxima etapa; você devolve APENAS JSON no contrato pedido — o texto vai direto para a interface, então capriche no conteúdo e seja específico ao projeto (nada de genérico). Escreva em português brasileiro. Diagramas em sintaxe mermaid válida.`

function contextBlock(session: PlanningSession): string {
  // Todas as respostas humanas até aqui, sempre re-enviadas: o --resume já
  // carrega o contexto, mas repetir o estado mantém o turno correto mesmo se a
  // sessão do harness se perder e for recomeçada.
  return `Estado atual (respostas do usuário por etapa):\n${JSON.stringify(session.answers, null, 2)}`
}

function turnPreamble(session: PlanningSession): string {
  return session.claude_session_id === null ? `${INTRO}\n\n${contextBlock(session)}` : contextBlock(session)
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function parseCommon(raw: unknown): { payload: Record<string, unknown>; out: StepOutput } {
  if (typeof raw !== 'object' || raw === null) throw new Error('resposta deve ser um objeto JSON')
  const r = raw as Record<string, unknown>
  const payload = r['screen_payload']
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('screen_payload ausente ou não é objeto')
  }
  const out: StepOutput = { screen_payload: payload }
  if (r['kad_patch'] !== undefined) {
    const patch = r['kad_patch']
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
      throw new Error('kad_patch deve ser um objeto {doc: markdown}')
    }
    const clean: Partial<Record<KadDocId, string>> = {}
    for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
      if (!(KAD_DOC_IDS as readonly string[]).includes(k)) {
        throw new Error(`kad_patch contém doc desconhecido "${k}" — use: ${KAD_DOC_IDS.join(', ')}`)
      }
      if (typeof v !== 'string') throw new Error(`kad_patch.${k} deve ser string markdown`)
      clean[k as KadDocId] = v
    }
    out.kad_patch = clean
  }
  if (r['structure'] !== undefined) out.structure = r['structure']
  return { payload: payload as Record<string, unknown>, out }
}

function parseForm(raw: unknown): StepOutput {
  const { payload, out } = parseCommon(raw)
  const fields = payload['fields']
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new Error('screen_payload.fields deve ser um array não-vazio')
  }
  for (const f of fields) {
    const o = f as Record<string, unknown>
    if (typeof o['id'] !== 'string' || typeof o['label'] !== 'string') {
      throw new Error('cada field precisa de id e label string')
    }
  }
  return out
}

function parseChoice(raw: unknown): StepOutput {
  const { payload, out } = parseCommon(raw)
  if (typeof payload['question'] !== 'string') throw new Error('screen_payload.question ausente')
  const options = payload['options']
  if (!Array.isArray(options) || options.length < 2) {
    throw new Error('screen_payload.options deve ter ao menos 2 opções')
  }
  for (const o of options) {
    const r = o as Record<string, unknown>
    if (typeof r['id'] !== 'string' || typeof r['label'] !== 'string') {
      throw new Error('cada option precisa de id e label string')
    }
  }
  return out
}

function parseList(raw: unknown): StepOutput {
  const { payload, out } = parseCommon(raw)
  const items = payload['items']
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('screen_payload.items deve ser um array não-vazio')
  }
  for (const i of items) {
    const r = i as Record<string, unknown>
    if (typeof r['id'] !== 'string' || typeof r['title'] !== 'string') {
      throw new Error('cada item precisa de id e title string')
    }
  }
  return out
}

function parseDiagram(raw: unknown): StepOutput {
  const { payload, out } = parseCommon(raw)
  if (typeof payload['mermaid'] !== 'string' || payload['mermaid'].trim() === '') {
    throw new Error('screen_payload.mermaid deve ser string mermaid não-vazia')
  }
  return out
}

function parseConfirm(raw: unknown): StepOutput {
  const { payload, out } = parseCommon(raw)
  if (typeof payload['markdown'] !== 'string' || payload['markdown'].trim() === '') {
    throw new Error('screen_payload.markdown deve ser string não-vazia')
  }
  return out
}

const PARSERS: Record<ScreenType, (raw: unknown) => StepOutput> = {
  form: parseForm,
  choice: parseChoice,
  list: parseList,
  diagram: parseDiagram,
  confirm: parseConfirm,
}

// ── Sequência ────────────────────────────────────────────────────────────────
// identidade → escopo → pessoas → comportamento → estrutura → execução → controle.

function step(
  id: StepId,
  title: string,
  screen: ScreenType,
  kadDocs: KadDocId[],
  task: string,
  opts: { prefill?: boolean; staticPayload?: unknown; withStructure?: boolean } = {},
): StepDef {
  const prefill = opts.prefill ?? true
  return {
    id,
    title,
    screen,
    kadDocs,
    prefill,
    ...(opts.staticPayload !== undefined ? { staticPayload: opts.staticPayload } : {}),
    buildPrompt: (session) =>
      `${turnPreamble(session)}\n\nPróxima etapa: "${title}" (tela ${screen}).\n${task}\n\n${contract(screen, opts.withStructure ?? false)}`,
    parseOutput: PARSERS[screen],
  }
}

export const STEPS: StepDef[] = [
  {
    id: 'identity',
    title: 'Identidade do projeto',
    screen: 'form',
    kadDocs: ['vision'],
    prefill: false,
    staticPayload: {
      fields: [
        { id: 'name', label: 'Nome do projeto', help: 'letras, números, pontos, hífens — vira o nome da pasta no vault' },
        { id: 'description', label: 'Descreva o projeto em algumas frases', help: 'o que é, para quem, e por que existe' },
        { id: 'target_repo', label: 'Caminho do repositório git (opcional)', help: 'absoluto — onde os agentes vão trabalhar' },
      ],
    },
    buildPrompt: () => {
      throw new Error('identity não tem prefill')
    },
    parseOutput: parseForm,
  },
  step(
    'project_type',
    'Tipo de projeto',
    'choice',
    ['vision'],
    'Com base na descrição, pergunte o tipo do projeto. Ofereça as opções PESSOAL, DOUTORADO, TRABALHO, OPEN-SOURCE e outras que façam sentido para este caso; marque em "suggested" a que a descrição indica. Inicie o documento vision em kad_patch com o que já se sabe.',
  ),
  step(
    'scope',
    'Escopo',
    'form',
    ['vision'],
    'Monte um form com dois campos: "positive_scope" (Escopos positivos — o que o projeto FAZ) e "negative_scope" (Escopos negativos — o que o projeto explicitamente NÃO faz). Pré-preencha ambos os "value" com propostas específicas derivadas da descrição, uma por linha. Atualize vision em kad_patch com a seção de escopo.',
  ),
  step(
    'users',
    'Usuários e personas',
    'list',
    ['prd'],
    'Proponha a lista de personas/usuários do sistema (id curto, title = nome da persona, detail = necessidades e contexto). O usuário poderá editar, remover e adicionar itens. Inicie o documento prd em kad_patch com a seção de usuários.',
  ),
  step(
    'stories',
    'Histórias de usuário',
    'list',
    ['stories'],
    'Proponha histórias de usuário no formato "Como <persona>, quero <ação> para <benefício>" (title = resumo curto, detail = história completa com critérios de aceite). Cubra as personas confirmadas. Crie o documento stories em kad_patch.',
  ),
  step(
    'use_cases',
    'Casos de uso',
    'confirm',
    ['prd'],
    'Redija em markdown os casos de uso principais derivados das histórias (atores, fluxo principal, fluxos alternativos), para o usuário confirmar ou pedir correções. Atualize prd em kad_patch com os casos de uso.',
  ),
  step(
    'domain_model',
    'Modelo de domínio',
    'diagram',
    ['domain_model'],
    'Gere um classDiagram mermaid com as entidades do domínio, atributos principais e relações. Peça confirmação no caption. Crie domain_model em kad_patch explicando cada entidade.',
  ),
  step(
    'modules',
    'Módulos do sistema',
    'list',
    ['architecture'],
    'Proponha os módulos/componentes do sistema (title = nome do módulo, detail = responsabilidade e dependências). Inicie architecture em kad_patch com a visão de módulos.',
  ),
  step(
    'communication',
    'Diagrama de comunicação',
    'diagram',
    ['architecture'],
    'Gere um flowchart ou sequenceDiagram mermaid mostrando como os módulos confirmados se comunicam (protocolos, direção, dados principais). Atualize architecture em kad_patch com a seção de comunicação.',
  ),
  step(
    'roadmap',
    'Roadmap',
    'confirm',
    ['roadmap'],
    'Redija em markdown um roadmap por fases (o que entra em cada fase e por quê, sem datas rígidas), do MVP à visão completa. Crie roadmap em kad_patch.',
  ),
  step(
    'milestones',
    'Milestones',
    'confirm',
    ['roadmap'],
    'Derive do roadmap os milestones verificáveis (nome, critério de conclusão objetivo, fase). Apresente em markdown para confirmação. Atualize roadmap em kad_patch com a seção de milestones.',
  ),
  step(
    'epics_features',
    'Épicos e features',
    'confirm',
    ['features'],
    'Agrupe o trabalho em épicos (nome + objetivo) e liste as features de cada um, em markdown para confirmação. Crie features em kad_patch.',
  ),
  step(
    'sprints_tasks',
    'Sprints e tarefas',
    'confirm',
    [],
    `Quebre os épicos confirmados em sprints e tarefas executáveis por agentes de IA. Além do markdown de confirmação em screen_payload, devolva o campo "structure" com EXATAMENTE esta forma:
{"project":{"name":"<nome informado na identidade>","target_repo":"<se informado>"},"goals":[{"title":"...","target_date":"YYYY-MM-DD ou null","notes":"..."}],"epics":[{"name":"...","objective":"...","sprints":[{"name":"...","goal":"...","tasks":[{"title":"...","type":"task|feature|bug|chore","body":"# Spec\\n<o que fazer, critérios de aceite>","priority":"low|medium|high|critical","tags":["..."]}]}]}]}
Cada task.body é a Spec que um agente dev vai executar sem mais contexto — seja específico. Sprints pequenas (3 a 8 tarefas).`,
    { withStructure: true },
  ),
  step(
    'risks_metrics',
    'Riscos e métricas',
    'form',
    ['knowledge'],
    'Monte um form com dois campos pré-preenchidos: "risks" (riscos do projeto com mitigação, um por linha) e "metrics" (métricas de sucesso mensuráveis, uma por linha). Crie knowledge em kad_patch consolidando riscos, métricas e decisões tomadas no wizard.',
  ),
  step(
    'review',
    'Revisão final',
    'confirm',
    [...KAD_DOC_IDS],
    'Última etapa: apresente em markdown um resumo executivo do plano completo (visão, escopo, épicos, sprints, riscos) para aprovação final. Em kad_patch, envie a versão final e consolidada de TODOS os documentos KAD (vision, prd, domain_model, architecture, knowledge, features, stories, roadmap) — completos, coerentes entre si e prontos para guiar os agentes.',
  ),
]

export const STEP_IDS: StepId[] = STEPS.map((s) => s.id)

export function stepById(id: string): StepDef | null {
  return STEPS.find((s) => s.id === id) ?? null
}

export function nextStep(id: StepId): StepDef | null {
  const idx = STEPS.findIndex((s) => s.id === id)
  return idx >= 0 && idx + 1 < STEPS.length ? STEPS[idx + 1]! : null
}

/** Prompt de refinamento: mesma etapa, feedback humano, mesmo contrato. */
export function buildRefinePrompt(session: PlanningSession, def: StepDef, feedback: string): string {
  return (
    `${contextBlock(session)}\n\nO usuário pediu correção na etapa "${def.title}": ${feedback}\n` +
    `Reenvie a etapa corrigida por completo. ${contract(def.screen, def.id === 'sprints_tasks')}`
  )
}

/** Prompt corretivo quando o JSON anterior não validou. */
export function buildRetryPrompt(def: StepDef, validationError: string): string {
  return (
    `Sua resposta anterior não validou: ${validationError}. ` +
    `Reenvie APENAS o objeto JSON corrigido, completo. ${contract(def.screen, def.id === 'sprints_tasks')}`
  )
}
