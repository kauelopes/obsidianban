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
| 4.1 — Sessão e lacunas de paridade | feito (sessão injetada, endurecimento cross-site, provisionamento na criação de projeto, rota `/ajuda`) |
| 4.2 — Crítica de estética e usabilidade | feito (duas iterações sobre prints reais; ver abaixo) |
| 4.3 — Home de supervisão e board por projeto | feito (home em `/`, board em `/board/:projeto`, `by_project` no `/metrics`, preparação p/ Codex) |
| 5 — Desligamento do plugin | não iniciado — é o próximo escopo |

Build e testes: `pnpm run build && pnpm run build:web && pnpm run typecheck && pnpm run test` — 515 testes verdes (371 server + 41 plugin + 103 web). Use `~/.local/share/pnpm/bin/pnpm` em shell não-interativo.

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

## O que a fase 4.1 entregou

**Sessão do navegador injetada.** O gate pedia um token de 43 caracteres a cada navegador novo. O servidor passou a cunhar um token de sessão ao subir — só em memória, nunca gravado no vault — e a injetá-lo no `index.html` que ele mesmo serve (`src/auth/session.ts`, `src/server/static.ts`). Rodar em loopback não dispensa autenticação: o token é a identidade de onde saem `role` e `agent_type`, sem a qual RBAC e audit log perdem sentido. O que se dispensou foi o humano digitar. Token colado continua vencendo a sessão, que é como se entra com um token de agente para conferir o que ele enxerga.

**Endurecimento das rotas POST.** A defesa contra uma aba de terceiros estava apoiada num único detalhe — header `Authorization` exige preflight —, mas o `readJsonBody` parseava o corpo sem olhar o `content-type`, então um POST "simples" com `text/plain` passava sem preflight nenhum. Agora `/mcp/tool/:name` e `/mcp` exigem `application/json`, recusam `Sec-Fetch-Site` cross-site e `Origin` de outro host, e recusam **antes de autenticar**. Cliente não-navegador não manda `Sec-Fetch-Site` e segue passando — curl, o CLI do dev agent e o `/mcp` foram verificados contra o servidor rodando.

**Provisionamento na criação de projeto.** `kanban_create_project` com `target_repo` só gravava o caminho; a provisão (skills, `mcp.json`, tokens de pm e dev) rodava apenas em `kanban_set_project_repo`. Os dois caminhos agora fazem a mesma coisa e devolvem o mesmo `workflow_readiness`.

**Rota `/ajuda`.** O briefing do agente, que só existia no `help-modal` do plugin e sairia junto com ele na fase 5. Texto atualizado: as três zonas, o `log_kind` no lugar do `[ESCALATE]` em texto livre, e as tools de supervisão.

---

## O que a fase 4.2 entregou

Duas iterações de crítica de estética/usabilidade sobre a interface rodando (prints reais em `127.0.0.1:9399`), a segunda feita por um agente sem o contexto da implementação, de propósito. O que sobreviveu à verificação e virou código:

**Iteração 1 — usabilidade do board.**
- **Card inteiro navegável** (`board/Board.tsx`): o corpo era só alça de drag e apenas o título abria o detalhe. O threshold de 4px do `PointerSensor` separa clique de drag; um flag de "acabou de arrastar" engole o click sintético pós-drop.
- **Colunas fluidas** (`components.css`): `flex: 1 1` com min/max no lugar dos 264px fixos — as cinco colunas cabem sem scroll horizontal em viewports comuns.
- **Timestamps humanos** (`src/util/time.ts`): ISO cru virou `dd/mm/aaaa, hh:mm` local, com o ISO completo preservado em `title=`/`dateTime`.
- Ação primária dos modais padronizada à direita; "vazio" das colunas rebaixado (itálico, opacidade); microcopy PT ("responsável", "prazo"); autofocus no primeiro campo dos dialogs.

**Iteração 2 — achados do crítico externo.**
- **Card arquivado recua de verdade** (`.card.archived`): opacidade 0.55, fundo transparente, borda tracejada. Antes, 30 arquivados em done eram idênticos aos ativos — o chip sozinho perdia a disputa visual.
- **Propriedades em modo leitura viram texto** (`.props-read` + `FrontmatterForm`): inputs desabilitados com placeholder faziam a zona parecer editável sempre e o botão "editar" parecer inerte. Leitura é grid de definição com "—" para vazio; o formulário só existe editando.
- **Barras da Atividade com escala honesta**: proporção do total, não do máximo (2 de 5 operações rendiam barra cheia); trilho visível nos dois temas (`--ink-3`).
- **MathJax no tema escuro**: o container mjx trazia cor própria embutida e a fórmula saía tinta-sobre-tinta; `color` forçado no CSS resolve.
- "encerrar sprint" no lugar de "fechar" (lia-se como fechar o modal); chip de claim neutro (identidade ≠ estado — o âmbar ficava idêntico ao de prioridade high); toggle "arquivados" persiste em `sessionStorage`; plurais; nota "em inglês de propósito" no briefing.

Fora das iterações, registrado para a próxima: teclado para drag-and-drop (KeyboardSensor + announcements), focus-trap nos dialogs, inputs de data nativos em formato US, zona destrutiva do modal "ajustes" sem separação visual.

---

## O que a fase 4.3 entregou

O board empilhado de todos os projetos em `/` ficou caótico com múltiplos projetos. A reestruturação:

**Home em `/`** (`src/home/Home.tsx` + `overview.ts`). Hub de supervisão com três seções em ordem de urgência: **"precisa de você"** (escalações com motivo + cards em `review`, linkando ao card — só aparece quando há itens), **grid de projetos** (contagens por status, sprint ativa com progresso done/total, sprints em planejamento com goal, último update; o tile inteiro é o link e ganha borda de alerta com decisões pendentes) e **uso** (tokens/custo por provedor e operações por projeto). O view-model é `buildOverview` em `overview.ts`, função pura derivada do que o `useBoard` já carrega — **zero chamadas extras**; o progresso da sprint ativa vem da contagem client-side dos cards com o `sprint_id` dela, não de N `kanban_get_sprint`.

**Board por projeto em `/board/:projeto`**. `useBoard` ganhou `opts.project` (o teto de 200 cards passa a valer por projeto no board); seletor de projeto na topbar (escondido para token dev, que não enxerga `kanban_list_projects`); busca e "arquivados" escopados; `/board` redireciona para `/`; "← board" no detalhe volta para o board do projeto do card. `Board.tsx` não mudou de assinatura — recebe `groups` com um item.

**`by_project` no `/metrics`** (`src/services/metrics.ts`). A coluna `project` e o índice sempre existiram no `token_log`; a sétima agregação (`GROUP BY project`) passou a expô-los. Tipo `Metrics` estendido no shared; a página Atividade ganhou o gráfico "operações por projeto" e perdeu a nota "não separa por projeto". Widgets `Tile`/`BarChart`/`TokenTable` extraídos para `src/metrics/widgets.tsx`, compartilhados com a home.

**Preparação para o Codex** (`packages/shared/src/index.ts`). `MODEL_PRICES_USD_PER_TOKEN` ganhou os modelos OpenAI (`gpt-5.x`, `*-codex`, `codex-mini`) com preço **marcado como aproximado** — conferir contra a tabela pública quando o Codex reportar de verdade. Nova `providerOf(model)` infere `anthropic | openai | other` do nome para a UI agrupar; os pseudo-modelos `human`/`plugin`/`unknown` caem em `other` e seguem sem preço. Nada de integração real: quando um agente reportar `model: "gpt-5.2-codex"`, custo e agrupamento já funcionam.

Escalações no `useBoard` agora guardam os `EscalationItem` completos (a home precisa de `reason`/projeto/prioridade); o `Set` de ids que o board usa é derivado. `ListCardsParams` ganhou `project?` no shared — o servidor sempre aceitou, só o tipo estava atrás.

---

## Verificação em browser

As três checagens que as fases 0–4 não conseguiram fazer — **MathJax em tela real, ida e volta do SSE (disco → tela) e o 409 exibido como resolução** — foram feitas manualmente pelo usuário em **2026-07-25**, junto com o resto da interface, e passaram.

Duas ressalvas para quem ler isto depois: a verificação foi **manual**, não há teste automatizado cobrindo esses três caminhos, e ela vale para o estado daquela data. Uma mudança no `Markdown.tsx`, no `ZoneEditor` ou no barramento SSE volta a ficar sem rede — o `jsdom` não pega renderização de MathJax nem `EventSource` de verdade.

---

## Decisões conscientes, não pendências

- **Teto de 200 cards sem paginação no `useBoard`.** No board o limite vale por projeto desde a fase 4.3; na home ainda é vault inteiro. Adequado à escala real; vira problema em milhares.
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
- **Em `vite dev` não há sessão injetada — o gate aparece, e isso é o esperado.** O `index.html` do dev server é o do Vite (porta 5273); só o `/mcp`, `/events`, `/health` e `/metrics` são proxied para o servidor kanban. A injeção acontece no `index.html` que o **servidor** serve, então ela só existe no build servido pela mesma origem. Em dev, cole um token — não é bug.
- **`kanban-token create --role agent` sempre grava `agent_type: 'pm'`.** Não existe flag `--agent-type` no CLI. Só a tool MCP `kanban_create_agent_token` minta um token dev de verdade. Já perdi tempo com um "dev token" que era pm disfarçado e passava onde devia falhar.
- **`packages/shared` compila para CommonJS** porque o servidor é CJS. O Vite precisa de `commonjsOptions.include` apontando para ele, senão exports de runtime como `parseSections` somem no build. Já está configurado em `packages/web/vite.config.ts` — não remova.
- **Não toque em `packages/plugin`** até decidir removê-lo na fase 5. Ele é o rollback natural.
- **O servidor é a autoridade.** Regras de negócio replicadas no cliente são hint de UX, nunca decisão. O 409 do servidor é que manda. Ver `packages/web/src/App.tsx`, `moveHint`.
- **`pnpm install --filter <pkg>` desconfigura o `node_modules` dos outros pacotes.** Use `pnpm install` sem filtro.

---

## Pendências do usuário, não suas

- `KANBAN_DEV_TOKEN` e `KANBAN_PM_TOKEN` não estão no `.env`. Sem eles o sprint workflow encerra com exit 2. Só o usuário pode gerar, e o caminho mais curto é a própria UI: em “ajustes” do projeto, reapontar o `target_repo` provisiona e devolve os dois já formatados como linha de env. Eles aparecem uma única vez.
- O branch `web-migration` não foi mergeado na `main`.
