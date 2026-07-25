# Handoff — estado da migração web após a fase 4

**Para:** próxima sessão
**Branch:** `web-migration` (nada mergeado na `main` ainda)
**Contexto obrigatório:** leia `docs/prd-web-migration.md` primeiro. Ele é o plano; este documento é o estado atual e o que falta.

---

## Onde o projeto está

As fases 0 a 4 do PRD estão feitas. O servidor MCP não mudou de arquitetura: continua sendo a única autoridade, e o web app é cliente HTTP/SSE puro.

| Fase | Estado |
|---|---|
| 0 — Higiene | feito (árvore duplicada removida, perda de body no watcher corrigida, workflow religado) |
| 1 — Contrato de três zonas | feito (`kanban_update_spec`, `kanban_update_notes`, parser em `packages/shared/src/sections.ts`) |
| 2 — Board MVP | feito (`packages/web`, board com dnd-kit, SPA servido da mesma origem) |
| 3 — Edição | feito (editor de card, formulário de frontmatter, criação de card/sprint) |
| 4 — Supervisão + redesenho | feito quanto a F1, F3 e F4; **F2 fora de escopo por falta de produtor de dados** (ver abaixo) |
| 5 — Desligamento do plugin | não iniciado — é o próximo escopo |

Build e testes: `pnpm run build && pnpm run build:web && pnpm run typecheck && pnpm run test` — 466 testes verdes (342 server + 41 plugin + 83 web). Use `~/.local/share/pnpm/bin/pnpm` em shell não-interativo.

---

## O que a fase 4 entregou

**F1 — Inbox de escalações** (`/inbox`). O marker `[ESCALATE]` em texto livre virou o campo estruturado `log_kind: progress | escalate | done | pm_resolved` em `kanban_log_on_card`. A tool nova `kanban_list_escalations` (`src/services/supervision.ts`) devolve os cards cuja última entrada explícita do `# Agent Log` é uma escalação, com o texto da pergunta. Responder grava um `pm_resolved`, o que tira o card da lista pela mesma regra que o pôs nela. O estado é derivado do arquivo, não indexado — uma escalação escrita à mão no Obsidian também aparece.

**F3 — Histórico do card** (aba no card detail). `kanban_get_card_history` (`src/services/history.ts`) lê `.kanban/audit.ndjson` de volta — até aqui nada em `src/` lia esse arquivo. O registro não é um formato plano: campos além de `ts` e `op` variam por call site, não só por `op`; quem consome checa presença.

**F4 — Custo visível** (`/atividade`). Painel sobre `/metrics`, com `estimateUsd` em `packages/shared`. O valor é **estimado** e a tela diz isso: o número autoritativo é o `total_cost_usd` que o harness reporta ao sprint workflow.

**Redesenho.** `packages/web/src/styles/` (`tokens.css`, `components.css`, `detail.css`) substitui o CSS portado do Obsidian. Duas regras governam: autoria não usa cor (tipografia e textura distinguem humano de agente) e cor só significa estado (alert / run / ok, com o acento interativo fora desse conjunto). Fontes IBM Plex via `@fontsource`, locais — sem CDN.

---

## Fora de escopo, com o motivo

Registrado aqui para o próximo Claude não reabrir a decisão:

- **F2 — Painel do sprint workflow: não feito, falta o produtor.** O runner (`packages/server/scripts/sprint-workflow.ts`) é processo independente e não publica estado; não existe evento `WORKFLOW_*` no SSE. Construir a UI antes disso seria uma tela sem dado. Ordem correta: runner publica → SSE transporta → painel consome.
- **F5 (templates de card por projeto) e F6 (subtasks via `parent_card_id`): não priorizados.** Nenhum dos dois é pré-requisito do desligamento do plugin.
- **`kanban_pick_next`, `kanban_claim_card`, `kanban_release_card`: sem UI, de propósito.** São o protocolo do dev agent. Um humano clicando "claim" compete com o agente pelo mesmo card sem ganhar nada.
- **`kanban_bulk_create_cards`: sem UI.** Existe para o PM agent criar um sprint inteiro numa chamada. O equivalente humano é criar card a card, que já existe.

---

## O que ficou por verificar

A fase 4 rodou sem browser. Isto **não** foi validado em tela de verdade:

1. **MathJax numa tela real.** Só exercitado em jsdom, e nenhum card dos dois vaults tem `$…$` — é preciso escrever um. A escolha de serif para o `# Spec` foi feita por causa do MathJax, então está sem prova.
2. **Ida e volta do SSE.** Editar o `.md` no disco → `CARD_HUMAN_EDITED` → a tela atualiza sem reload, inclusive com o card detail aberto. O caminho disco→tela nunca foi exercitado.
3. **Conflito 409.** Mesma `version` alterada pela UI e por `curl`. A tela deve mostrar resolução, não erro cru.

---

## Decisões conscientes, não pendências

- **Teto de 200 cards sem paginação no `useBoard`.** Adequado à escala real do vault; vira problema em milhares.
- **`listEscalations` faz uma leitura de arquivo por card ativo.** Deliberado: sem índice derivado não há o que dessincronizar, e o `.md` é a fonte de verdade. Em milhares de cards valeria uma coluna preenchida na reconciliação.
- **`health()` é o único método do cliente sem call site.** Mantido como sonda de diagnóstico.

---

## Sobre a fase 5

Remover `packages/plugin`, atualizar docs e skills. Antes de deletar, confirme que o web cobre o fluxo completo — o plugin congelado é o rollback natural. `packages/plugin/src/view/metrics-view.ts` já foi reconstruído como `/atividade`, então não há mais nada de único lá.

---

## Como verificar o que você fizer

**Isto é o mais importante deste documento.** Nas fases 0 a 3 eu não consegui abrir a interface em browser — a extensão do Chrome não estava conectada — e isso deixou passar três bugs que só apareceram quando o usuário abriu a tela:

1. O filtro de sprint vinha sempre vazio, porque eu li `sprints` da resposta de `kanban_list_projects`, que não tem esse campo.
2. O board aparecia vazio, porque `kanban_list_cards` esconde arquivados por padrão e eu não portei o toggle `showArchived` que o plugin tinha. No vault real do usuário, os 30 cards de `avare` estão todos arquivados.
3. O tipo de retorno de `kanban_create_project` declarava um subconjunto do que a tool devolve.

Os três têm a mesma origem: **escrevi a suposição na assinatura do método em vez de verificar contra o servidor.** Ao declarar um campo que a API não retorna, o TypeScript passa a confirmar a crença errada em vez de confrontá-la.

Então:

- **Tente o browser primeiro.** `mcp__claude-in-chrome__*` via ToolSearch. Se conectar, use — screenshots e interação real valem mais que qualquer teste que você escreva.
- **Se não conectar, diga isso explicitamente no relatório**, e não deixe implícito que a UI foi validada.
- **Verifique toda forma de resposta contra o servidor rodando** antes de escrever o tipo. Suba o servidor contra uma cópia do `test-vault/` e chame a tool com `curl`. Nunca derive o tipo do que parece razoável.
- Testes de cliente com `fetch` stubado existem em `packages/web/tests/client.test.ts` e travam os parâmetros enviados. Respostas reais capturadas do servidor estão em `packages/web/tests/fixtures/` — estenda esse padrão em vez de inventar a forma.

Setup para testar sem tocar no vault real:

```bash
cp -r test-vault /tmp/kanban-teste && rm -f /tmp/kanban-teste/.kanban/db.sqlite*
VAULT_PATH=/tmp/kanban-teste MCP_HTTP_PORT=9399 node packages/server/dist/index.js &
VAULT_PATH=/tmp/kanban-teste node packages/server/dist/auth/cli.js create --role manager --actor "human:dev"
# cole o token no gate em http://127.0.0.1:9399
```

O card `card-2vorDD5G` do `test-vault` tem mermaid no Agent Log — é o caso de teste natural para rendering.

---

## Armadilhas conhecidas

- **O `access` do `TOOL_CATALOG` não é controle de acesso.** Ele filtra o `tools/list` do MCP; a rota REST `/mcp/tool/:name` executa qualquer tool registrada para qualquer token válido. A recusa por papel mora no serviço — `requirePmOrManager` em `src/services/guards.ts`. Marcar uma tool nova como `'pm'` no catálogo e parar por aí deixa o dev agent chamá-la.
- **`kanban-token create --role agent` sempre grava `agent_type: 'pm'`.** Não existe flag `--agent-type` no CLI. Só a tool MCP `kanban_create_agent_token` minta um token dev de verdade. Já perdi tempo com um "dev token" que era pm disfarçado e passava onde devia falhar.
- **`packages/shared` compila para CommonJS** porque o servidor é CJS. O Vite precisa de `commonjsOptions.include` apontando para ele, senão exports de runtime como `parseSections` somem no build. Já está configurado em `packages/web/vite.config.ts` — não remova.
- **Não toque em `packages/plugin`** até decidir removê-lo na fase 5. Ele é o rollback natural.
- **O servidor é a autoridade.** Regras de negócio replicadas no cliente são hint de UX, nunca decisão. O 409 do servidor é que manda. Ver `packages/web/src/App.tsx`, `moveHint`.
- **`pnpm install --filter <pkg>` desconfigura o `node_modules` dos outros pacotes.** Use `pnpm install` sem filtro.

---

## Pendências do usuário, não suas

- `KANBAN_DEV_TOKEN` e `KANBAN_PM_TOKEN` não estão no `.env`. Sem eles o sprint workflow encerra com exit 2. Só o usuário pode gerar (precisa do token de manager contra o vault real).
- O branch `web-migration` não foi mergeado na `main`.
