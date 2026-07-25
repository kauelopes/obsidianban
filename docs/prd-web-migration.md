# PRD — Migração da visualização para Web

**Status:** aprovado, não iniciado
**Data:** 2026-07-24
**Escopo:** substituir o plugin Obsidian por um web app React, com editor de card que separa explicitamente conteúdo humano de conteúdo gerado por agentes.

> Este documento é autocontido. Ele descreve o estado atual verificado do código, as decisões tomadas e o que precisa ser construído. O PRD original do projeto está em `docs/archive/prd/` e **não** reflete o estado atual.

---

## 1. Problema

O ObsidianKan usa o Obsidian por duas portas distintas:

1. O plugin (`packages/plugin`) desenha o board.
2. O editor markdown do próprio Obsidian é para onde o board delega quando se abre um card — `packages/plugin/src/view/board-view.ts:419`, `openCardFile()`, faz `app.workspace.getLeaf(false).openFile(file)`.

A segunda porta é a que realmente importa e a que não tem substituto. Ela também é a origem do problema central: **não existe distinção de interface entre o que o humano escreve num card e o que os agentes escreveram nele.** Tudo é um blob markdown único, editado no mesmo campo.

### O buraco central

O contrato de escrita atual é assimétrico e incompleto:

- `body` é **write-once na criação**. `kanban_update_card` com `body` retorna `400 body_immutable` (`packages/server/src/services/card-writer.ts:250`).
- Agentes só fazem *append* na seção `# Agent Log`, via `log_entry` (`card-writer.ts:326-344`).
- **O humano não tem nenhum endpoint para editar o spec de um card.** A única via é editar o `.md` no Obsidian e deixar o chokidar reconciliar (`packages/server/src/watcher/file-watcher.ts`).

A separação humano/agente que queremos **já existe estruturalmente** — o body é humano, o `# Agent Log` é do agente — mas sem contrato explícito, sem validação e sem API. Ao remover o Obsidian, remove-se a única forma de o humano escrever num card. Fechar esse buraco é pré-requisito da migração, não um extra.

---

## 2. Decisões

| Decisão | Escolha | Consequência |
|---|---|---|
| Papel do Obsidian | Substituição total do plugin | Os `.md` continuam no vault; o file-watcher continua ativo |
| Deploy | Local, mesma máquina (localhost) | SPA servido da mesma origem: sem CORS, sem mudar o bind `127.0.0.1` |
| Stack do frontend | React + Vite + TypeScript | Resolve o rebuild total do board; ecossistema para editor e dnd |
| Math rendering | **MathJax** (`rehype-mathjax`) | Fidelidade com o conteúdo existente, escrito e conferido no Obsidian, que usa MathJax 3 |
| Diagramas | mermaid, `securityLevel` default | Não habilitar `rehype-raw` |
| Modelo do card | Três zonas explícitas no body | Ver §4 |

### Sobre MathJax vs KaTeX

KaTeX é mais rápido e leve, mas MathJax foi escolhido por **fidelidade**: os cards existentes foram escritos dentro do Obsidian, que renderiza `$...$` e `$$...$$` via MathJax 3. Usar MathJax garante que nada renderize diferente após a migração. O custo é bundle maior e rendering assíncrono, irrelevante em localhost.

### Sobre segurança do mermaid

`securityLevel: 'strict'` já é o padrão do mermaid — escapa HTML nos labels e ignora diretivas `click`. As advisories de XSS historicamente atingem quem opta por `'loose'`. Com bind em loopback e single-user, **isto não requer trabalho adicional**: manter o default e não habilitar `rehype-raw` encerra o assunto. Não é item de roadmap.

---

## 3. Estado atual verificado

### O que já existe e migra sem custo

O servidor é standalone e agnóstico de cliente. **O plugin nunca lê o vault para obter dados do board** — é cliente HTTP/SSE puro de `127.0.0.1:9375`. Toda a lógica de negócio está no servidor. Esta migração é de UI, não de arquitetura.

`packages/server/src/server/http.ts` (implementado em `node:http` cru — a menção a "Hono" em `docs/for-developers/architecture.md` está errada) já expõe:

| Rota | Descrição |
|---|---|
| `POST /mcp/tool/:name` | Superfície REST-ish, Bearer token. Usada pelo plugin e pelo sprint workflow |
| `GET /events` | SSE, replay buffer de 100 eventos, resume via `Last-Event-ID`. **Não autenticado** |
| `GET /health` | 503 `reconciling` durante o startup |
| `GET /metrics` | Loopback-only, filtros `from_date`/`to_date` |
| `POST /mcp` | Streamable HTTP stateless para agentes MCP |

Portável **sem alteração**:

| Artefato | Por quê |
|---|---|
| `packages/shared/src/index.ts` | Contrato normativo, zero dependência de runtime |
| `packages/plugin/src/view/render.ts` → `groupBoard()` | Função pura, já com testes |
| `packages/plugin/src/view/state.ts` | 4 funções puras de patch de lista |
| `packages/plugin/src/mcp/sse-parser.ts` | Parser puro de frames SSE |

O `McpResult<T>` de `packages/plugin/src/mcp/client.ts` — union discriminada `conflict | validation | server | offline`, que nunca lança — é bom design e deve sobreviver à reescrita. Muda o transporte: `node:http` → `fetch`, e `sse-subscriber.ts` (126 linhas de reconnect com backoff) → `EventSource` nativo, que entrega reconnect e `Last-Event-ID` de graça. Isso também dissolve o `isDesktopOnly: true` do `manifest.json`, que existia por causa dessa escolha de transporte.

### Modelo de dados atual

Um card = um `.md` com frontmatter YAML. Fonte de verdade é o arquivo; SQLite é índice derivado e reconstruível.

```
$VAULT_PATH/
├── kanban-data/            # sem ponto → Obsidian indexa
│   └── <project>/
│       ├── _meta.json      # columns, sprints[], agent_tokens[], target_repo
│       └── <card-slug>.md
└── .kanban/                # interno do servidor
    ├── db.sqlite           # índice derivado, deletável
    ├── audit.ndjson        # append-only
    ├── idempotency.json
    └── manager-tokens.json
```

O `Card` (23 campos de frontmatter) está em `packages/shared/src/index.ts`. Ordem canônica das chaves em `packages/server/src/cards/serialize.ts` (`FRONTMATTER_KEYS`). Colunas padrão em `packages/server/src/vault/layout.ts:7`. **Sprints vivem apenas em `_meta.json`** — não há tabela nem arquivo de sprint; o vínculo é o campo `sprint_id`.

### Rendering hoje

**O projeto não renderiza nada.** Armazena texto markdown; o Obsidian faz todo o rendering. Uma busca por `katex|mathjax|latex` em `packages/`, `docs/` e `.claude/` retorna zero. O único uso de `MarkdownRenderer` no plugin está em `ui/help-modal.ts:19`, para o texto de ajuda — nenhum card passa por lá.

A menção a mermaid em `packages/server/src/server/tool-catalog.ts:25` ("Supports markdown and mermaid diagrams") é uma **promessa feita aos agentes e cumprida pelo Obsidian**, não por código deste repositório. Com a substituição total, essa promessa passa a ser responsabilidade do web app.

---

## 4. Modelo de três zonas

### Formato do arquivo

Seções canônicas no body. **O frontmatter não muda.**

```markdown
---
id: card-2vorDD5G
... (23 campos, inalterados)
---

# Spec

Contexto, critérios de aceite, restrições.
Escrito por humano e PM. É o "o que fazer".

# Notes

Working memory do agente. Substituível, não histórico.
Decisões de abordagem, links, descobertas.

# Agent Log

**2026-06-01T00:53:07Z**

Append-only. Timeline imutável.
```

### Contrato de escrita por zona

| Zona | Humano (web) | PM agent | Dev agent |
|---|---|---|---|
| frontmatter | edita subset | edita subset | só `claim` / `move` |
| `# Spec` | read-write | read-write | **read-only** |
| `# Notes` | read-only | read-write | read-write |
| `# Agent Log` | read-only | append | append |

O ganho: a assimetria deixa de ser convenção e vira invariante verificável pelo servidor — que já tem o vocabulário para isso (`rejectDisallowed` e as allow-lists por operação em `packages/server/src/services/validation.ts`, mais `agent_type: 'pm' | 'dev'` nas claims).

### Requisitos de implementação

**R4.1 — Parser de seções.** Novo `packages/server/src/cards/sections.ts`, com `parseSections(body)` / `serializeSections(zones)`. **Tolerante a cards legados:** body sem headings reconhecidos vira integralmente `# Spec`; `# Agent Log` existente é preservado como está. **Nenhuma migração de dados é obrigatória** — o parser absorve o formato atual.

**R4.2 — Tools novas.** Implementar em `packages/server/src/services/card-writer.ts`, registrar em `server/tool-catalog.ts` + `server/tool-schemas.ts` + o mapa `handlers` de `src/index.ts` (o composition root falha rápido se catálogo e handler divergirem).

| Tool | Acesso | Params |
|---|---|---|
| `kanban_update_spec` | `pm` | `id`, `version`, `spec` |
| `kanban_update_notes` | `all` | `id`, `version`, `notes` |

Ambos sujeitos a optimistic locking como qualquer mutação. `kanban_log_on_card` **não muda** — já faz a coisa certa.

**R4.3 — `body_immutable` continua valendo.** Não relaxar a regra: ninguém escreve o body inteiro. Cada zona tem seu tool e sua regra de acesso. Isso preserva a garantia existente e a torna mais granular.

**R4.4 — Auth do humano.** Não é preciso mecanismo novo. Com localhost e substituição total do plugin, o web app usa um token manager, e as escritas humanas gravam `updated_by: 'human:<actor>'`, seguindo a convenção que o watcher já usa (`file-watcher.ts:222`). Mantém a atribuição correta no audit log sem inventar camada de sessão.

**R4.5 — Regenerar o catálogo.** `pnpm run gen:tools` após adicionar as tools, para atualizar `docs/for-agents/tool-catalog.md`.

---

## 5. O web app

### Estrutura

Novo workspace `packages/web/` (React + Vite + TS), adicionado ao `pnpm-workspace.yaml`.

**R5.1 — Servir da mesma origem.** O servidor ganha rota estática servindo o build de `packages/web/dist`. Consequência: sem CORS, sem mudar o bind `127.0.0.1`, sem repensar o modelo de segurança.

### Camadas

| Camada | Requisito |
|---|---|
| Cliente | Porta de `mcp/client.ts` para `fetch`, preservando `McpResult<T>` e os ~25 métodos tipados |
| Realtime | `EventSource` sobre `/events`, com o mapa de 14 eventos que `plugin/src/main.ts:234` já define |
| Board | `groupBoard()` reaproveitado; drag & drop com `dnd-kit` |
| Card detail | Rota `/card/:id`, três painéis espelhando as três zonas |
| Rendering | `react-markdown` + `remark-gfm` + `remark-math` + `rehype-mathjax` + `mermaid` |

### R5.2 — O editor de card

É a peça que não existe hoje em lugar nenhum e a que justifica a migração.

- **Frontmatter → formulário tipado.** Título, prioridade (enum), tags, due date, assignee, sprint, e `blocked_by` **com autocomplete sobre os cards do projeto** — hoje editar `blocked_by` significa digitar ids à mão no YAML. Campos gerenciados pelo sistema (`id`, `version`, `position`, `total_*_tokens`, timestamps) aparecem read-only, não escondidos.
- **`# Spec` → editor markdown** com preview. Única zona que o humano escreve livremente.
- **`# Notes` → colapsável**, visualmente distinto, read-only por padrão com toggle de edição.
- **`# Agent Log` → timeline read-only**, uma entrada por timestamp, colapsável, com markdown/MathJax/mermaid renderizados. Ancorável por timestamp.

### R5.3 — Ganhos que vêm junto

- **Reorder dentro da coluna.** `kanban_reorder_card` existe no servidor desde sempre e **nunca foi exposto na UI** — o plugin só faz move entre colunas.
- **Fim do rebuild total.** `board-view.ts:117` faz `contentEl.empty()` e reconstrói o board inteiro a cada evento SSE, destruindo scroll e estado de drag.
- **Busca e filtros.** Hoje só há filtro por sprint e um toggle `showArchived`. Sem busca textual, sem filtro por assignee, prioridade ou tag.

### R5.4 — Regras de negócio que estão no cliente

O plugin duplica validações que o servidor já faz: bloqueio de move cross-project (`board-view.ts:442`), sprint lock (450-467), checagem de blockers (471-480), recusa de criação sem sprint aberta (546-555). Na reescrita, tratar como **hint de UX** (desabilitar o alvo de drop e explicar o porquê), nunca como regra — a autoridade é o servidor, que retorna 409 com `next_action`.

### R5.5 — CSS

`packages/plugin/styles.css` tem 987 linhas com **136 usos de variáveis CSS do Obsidian**. As ~19 variáveis precisam de definição própria: `--background-primary`, `--background-secondary`, `--background-modifier-border`/`-hover`/`-error`/`-form-field`, `--text-normal`, `--text-muted`, `--text-faint`, `--text-error`, `--text-on-accent`, `--interactive-accent`/`-hover`, `--color-green`/`-orange`/`-red`/`-yellow`, `--font-monospace`. Remover as linhas 492-509, que escondem o widget Properties do Obsidian.

---

## 6. Dívidas técnicas

As duas primeiras são independentes da migração e valem por si.

**D1 — Árvore de código duplicada e obsoleta na raiz.** `src/` (40 arquivos), `tests/` (20), `scripts/` (36), `plugin/` (29) são cópias pré-monorepo, git-tracked e **divergentes** de `packages/`. Junto vão os configs órfãos que só as servem: `tsconfig.json`, `tsconfig.scripts.json`, `tsconfig.workflow.json`, `vitest.config.ts` — nenhum package os herda (`extends` não aparece em `packages/*/tsconfig.json`) e cada package tem os seus.

Verificado como seguro remover: `pnpm-workspace.yaml` lista só `packages/*`, todos os scripts do root delegam via `pnpm --filter`, e o `Makefile` também. Quem grepa o repo acerta o arquivo errado metade das vezes. **Maior retorno por menor esforço do projeto inteiro.**

```bash
git rm -r src tests scripts plugin tsconfig.json tsconfig.scripts.json tsconfig.workflow.json vitest.config.ts
```

`dist/` na raiz é untracked (gitignored) e artefato da árvore morta — decisão separada, pois a deleção não é reversível pelo git.

**D2 — Perda de dados no watcher.** `packages/server/src/watcher/file-watcher.ts:241-245`, `revertToCanonical()` chama `this.writer.write(card, '', basename)` — reescreve o arquivo com **body vazio**. Acionado quando o frontmatter fica improcessável ou o `id` é adulterado. Destrói o conteúdo do card sem backup. Corrigir para preservar o body original antes de confiar no watcher como rede de segurança pós-Obsidian.

**D3 — Drift de slug de coluna.** `packages/plugin/src/view/render.ts:3` usa `'in-progress'`; o servidor canonizou `'in_progress'` e tem migração para isso (`vault/layout.ts:87-94` e `migrateStatusHyphensToUnderscores`). Some junto com a reescrita da UI.

**D4 — Tokens em plaintext no vault.** `packages/plugin/src/main.ts:225-264` escreve `_kanban-secrets/<project>.md` com o token bruto. Com o plugin morto, isso precisa de novo lar — a UI web deve mostrar o token uma vez e não persistir em arquivo.

**D5 — Documentação divergente.** `docs/for-developers/architecture.md` afirma que o HTTP layer é Hono; é `node:http` cru. `docs/reference/config.md` documenta um default de `WORKFLOW_SCRIPT_PATH` da era de container que não existe no código.

**D6 — `/events` não autenticado.** Aceitável em localhost single-user, mas qualquer processo local lê o stream inteiro do board. Vale um Bearer check quando for barato.

### Configuração ativa quebrada

Encontrado no `.env` local, afeta o sistema rodando agora:

**C1 — Auto-launch do sprint workflow silenciosamente desligado.** `WORKFLOW_ENABLED=true`, mas `WORKFLOW_SCRIPT_PATH` não está definido. `packages/server/src/services/workflow-runner.ts:28-31` não tem default: emite `logger.warn` e retorna `null`. `kanban_start_sprint` nunca dispara o workflow.

**C2 — `WORKFLOW_LOG_DIR=/vault/.sprint-logs` aponta para caminho inexistente.** `/vault` era da era de container, removida no commit `4b4c389` (host-only). Mesmo corrigindo C1, os logs iriam para um diretório inválido.

Correção:
```bash
WORKFLOW_SCRIPT_PATH=<repo>/packages/server/dist/sprint-workflow.js
WORKFLOW_LOG_DIR=<vault>/.sprint-logs
```
Confirmar que o arquivo existe após `pnpm run build` — o `sprint-workflow.ts` vive em `packages/server/scripts/`.

---

## 7. Features propostas

O objetivo declarado do projeto é um kanban operado simultaneamente por agentes e humanos. Mas o gargalo real do humano **não é gerenciar cards — é supervisionar agentes autônomos.** As features de maior valor são de observabilidade e controle do loop. Em ordem de retorno:

**F1 — Inbox de escalações.** Hoje uma escalação é: `[ESCALATE]` no texto livre do log + card em `review` + `assigned_to: null`. Encontrar isso exige ler logs card a card. Uma view que lista decisões pendentes com ações diretas ("Resolver / Devolver ao todo / Escalar").

**Melhor ainda: promover o marker de convenção-em-texto para campo estruturado** — um `log_kind: progress | escalate | done | pm_resolved` em `kanban_log_on_card`. A inbox vira uma query em vez de um regex, e as skills de PM/Dev ganham um contrato verificável em vez de um prefixo combinado.

**F2 — Painel do sprint workflow.** `packages/server/scripts/sprint-workflow.ts` roda como processo independente, escreve em `WORKFLOW_LOG_DIR`, e o board não sabe que ele existe. Round atual, custo acumulado em USD, qual harness está executando — nada é visível. Exige eventos SSE novos (`WORKFLOW_*`) e o runner publicando estado.

**F3 — Histórico do card.** `.kanban/audit.ndjson` já registra toda mutação com `changed_fields`, ator, modelo e tokens. **Nenhuma UI expõe isso.** Uma aba "History" no card detail, alimentada por um `kanban_get_card_history`, entrega auditoria real — o dado já está no disco.

**F4 — Custo visível.** `total_input_tokens`/`total_output_tokens` estão em cada card; `/metrics` já agrega por dia, modelo, agente e operação; o workflow já calcula USD. A `metrics-view` do plugin morre na migração e precisa ser reconstruída de qualquer forma — reconstruir como dashboard, com custo por card e por sprint.

**F5 — Templates de card por projeto** (roadmap V2 original). Com zonas explícitas fica natural: o template define o esqueleto do `# Spec`. Reduz a variância dos cards que o PM gera e melhora a taxa de execução autônoma do dev.

**F6 — Subtasks via `parent_card_id`** (roadmap V3 original). Registrado, não priorizado.

---

## 8. Riscos

Ao aposentar o plugin perde-se: editor markdown maduro, backlinks, busca global do vault, acesso mobile, ecossistema de plugins.

Mitigações:

- Os `.md` continuam no vault. O Obsidian continua abrindo e editando — só não haverá board dentro dele.
- **Não desligar o file-watcher.** É ele que garante que uma edição manual continue reconciliando. Corrigir D2 antes de confiar nisso.
- **Não deletar `packages/plugin` de imediato.** Congelar e remover só depois que o web app cobrir o fluxo completo — é o rollback natural.

---

## 9. Fases

| Fase | Escopo | Entrega |
|---|---|---|
| **0 — Higiene** | D1, D2, D5, C1, C2 | Repo confiável para navegar; workflow religado |
| **1 — Backend de zonas** | R4.1–R4.5, R5.1 | Contrato de três zonas via HTTP, ainda sem UI |
| **2 — Board MVP** | `packages/web/`, cliente `fetch`, `EventSource`, board com dnd-kit, card detail read-only com MathJax + mermaid | Board web usável em paralelo ao Obsidian |
| **3 — Edição** | R5.2, criação de card/projeto/sprint, substituição dos 14 modais de `plugin/src/ui/` | Paridade funcional com o plugin |
| **4 — Supervisão** | F1 (+ `log_kind`), F3, F4, e o redesenho da interface | Supera o plugin |
| **5 — Desligamento** | Remover `packages/plugin`; atualizar docs e skills | Migração concluída |

As fases 0 e 1 valem mesmo que a migração não aconteça.

### O que ficou de fora da fase 4, e por quê

- **F2 — painel do sprint workflow.** Cortado por falta de produtor de dados: o runner é processo independente, não publica estado e não existe evento `WORKFLOW_*` no SSE. A UI viria antes do dado. Ordem correta quando for feito: runner publica → SSE transporta → painel consome.
- **F5 (templates de card) e F6 (subtasks).** Não priorizados; nenhum é pré-requisito do desligamento do plugin.
- **`kanban_pick_next`, `kanban_claim_card`, `kanban_release_card` sem UI.** São o protocolo do dev agent. Um humano clicando "claim" compete com o agente pelo mesmo card sem ganhar nada.
- **`kanban_bulk_create_cards` sem UI.** Existe para o PM agent criar um sprint inteiro numa chamada; o equivalente humano é criar card a card, que já existe.

---

## 10. Critérios de aceitação

### Fase 0
- `pnpm run build && pnpm run typecheck && pnpm run test` verdes após remover a árvore stale. Se quebrar, algo estava importando código morto — que é o que se quer descobrir.
- Teste novo em `packages/server/tests/service/`: frontmatter corrompido → **body preservado**.
- `kanban_start_sprint` dispara o workflow e grava log no diretório configurado.

### Fase 1
- Testes unitários de `sections.ts`: card legado (sem headings), card só com `# Agent Log`, card nas três zonas.
- Round-trip `parseSections` → `serializeSections` idempotente sobre os cards reais de `test-vault/`.
- Integração: `kanban_update_spec` como dev agent → 403; como PM → sucesso **e `# Agent Log` intacto**.
- Optimistic locking: dois `update_spec` com a mesma `version` → o segundo retorna 409 com `current_card`.

### Fase 2+
- Servidor contra `test-vault/`, SPA em `127.0.0.1:9375`.
- Board reflete `kanban-data/*/`; mover card na UI muda `status` no `.md` e emite `CARD_MOVED` no SSE.
- Editar o `.md` direto no disco → `CARD_HUMAN_EDITED` chega e o board atualiza sem reload.
- Card com `$$...$$` e bloco ` ```mermaid ` renderiza corretamente no detail.
- Conflito: alterar a mesma `version` pela UI e por `curl` → UI mostra resolução, não erro cru.
- Percorrer o checklist manual de `docs/for-developers/testing.md` (~linha 205), que serve como spec de aceitação da porta.

---

## 11. Mapa de arquivos

**Servidor — alterar**

| Arquivo | Mudança |
|---|---|
| `packages/server/src/cards/sections.ts` | *novo* — parser de zonas |
| `packages/server/src/services/card-writer.ts` | tools de spec/notes; regra de imutabilidade por zona |
| `packages/server/src/server/tool-catalog.ts` | registrar tools + acesso |
| `packages/server/src/server/tool-schemas.ts` | JSON Schema das tools |
| `packages/server/src/index.ts` | mapa `handlers` |
| `packages/server/src/server/http.ts` | rota estática para o SPA |
| `packages/server/src/watcher/file-watcher.ts:241` | correção D2 |

**Servidor — reusar, não reescrever**

`services/validation.ts` (`rejectDisallowed` e as allow-lists por operação são o mecanismo certo para as regras de zona), `writer/atomic.ts`, `services/errors.ts`, `audit/logger.ts`.

**Web — portar de**

`packages/plugin/src/view/render.ts` (`groupBoard`), `view/state.ts`, `mcp/sse-parser.ts`, `mcp/client.ts` (tipos de erro), `styles.css`.

**Convenções do repo** (de `CLAUDE.md`, valem para código novo)

- Sempre `logger` de `util/logger.js` — nunca `console.log`
- Constantes em `util/constants.ts`
- Erros de `services/errors.ts` (`ConflictError`, `ValidationError`, `NotFoundError`)
- **Extensão `.js` obrigatória nos imports** (NodeNext)
- Sem comentários óbvios; comentar só o "porquê" não óbvio
- Sem error handling para cenários impossíveis
