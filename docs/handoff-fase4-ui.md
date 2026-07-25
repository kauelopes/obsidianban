# Handoff — completar e redesenhar a interface web

**Para:** próxima sessão
**Branch:** `web-migration` (4 commits à frente da `main`, nada mergeado ainda)
**Contexto obrigatório:** leia `docs/prd-web-migration.md` primeiro. Ele é o plano; este documento é o estado atual e o que falta.

---

## Onde o projeto está

As fases 0 a 3 do PRD estão feitas e commitadas. O servidor MCP não mudou de arquitetura: continua sendo a única autoridade, e o web app é cliente HTTP/SSE puro.

| Fase | Estado |
|---|---|
| 0 — Higiene | feito (árvore duplicada removida, perda de body no watcher corrigida, workflow religado) |
| 1 — Contrato de três zonas | feito (`kanban_update_spec`, `kanban_update_notes`, parser em `packages/shared/src/sections.ts`) |
| 2 — Board MVP | feito (`packages/web`, board com dnd-kit, SPA servido da mesma origem) |
| 3 — Edição | feito (editor de card, formulário de frontmatter, criação de card/sprint) |
| **4 — Supervisão** | **não iniciado — é o seu escopo, junto com o redesenho** |
| 5 — Desligamento do plugin | não iniciado |

Build e testes: `pnpm run build && pnpm run build:web && pnpm run typecheck && pnpm run test` — 408 testes verdes. Use `~/.local/share/pnpm/bin/pnpm` em shell não-interativo.

---

## Sua tarefa

Duas coisas, e elas devem ser planejadas juntas porque uma condiciona a outra:

1. **Levantar o que já existe no servidor e não está exposto na interface**, e decidir o que precisa subir para a UI para o produto web ficar utilizável de fato.
2. **Redesenhar a interface.** A atual é funcional mas feia — CSS escrito às pressas, sem hierarquia visual, sem identidade. Trate isso como parte do trabalho, não como polimento posterior.

**Comece em plan mode.** Apresente um plano antes de escrever código. O usuário quer avaliar o escopo e as escolhas de design antes da execução.

---

## Dado apurado: 13 das 30 tools não têm interface

Levantado com diff entre `packages/server/src/server/tool-catalog.ts` e `packages/web/src/api/client.ts`:

```
kanban_add_to_sprint          kanban_move_between_sprints
kanban_archive_project        kanban_pick_next
kanban_bulk_create_cards      kanban_release_card
kanban_claim_card             kanban_set_project_repo
kanban_create_agent_token     kanban_unarchive_project
kanban_delete_project         kanban_get_sprint
kanban_log_on_card
```

Rotas HTTP existentes e não consumidas: **`/metrics`** (agrega por dia, modelo, agente e operação; loopback-only).

Não trate essa lista como um checklist a implementar cegamente. Várias dessas tools são para agentes, não para humanos — `pick_next`, `claim_card` e `release_card` existem para o dev agent. A pergunta certa é *o que o humano precisa fazer que hoje não consegue*, e a resposta provável tem mais a ver com **supervisão de agentes** do que com gestão de cards.

O PRD §7 argumenta exatamente isso: o gargalo do humano não é gerenciar cards, é supervisionar agentes autônomos. Leia essa seção antes de priorizar. As features propostas lá (F1 inbox de escalações, F2 painel do workflow, F3 histórico do card, F4 custo visível) foram pensadas com esse critério, e F1 sugere promover o marker `[ESCALATE]` de convenção-em-texto para um campo estruturado `log_kind` — o que é mudança de servidor, não só de UI.

Também faltam capacidades óbvias que não são tools novas: **não há como arquivar, desarquivar ou deletar um card pela interface**, embora o cliente já tenha os métodos. E não há painel de métricas — o plugin tinha um (`packages/plugin/src/view/metrics-view.ts`) que morreu na migração e precisa ser reconstruído de qualquer forma.

---

## Sobre o redesenho

O CSS atual está em `packages/web/src/styles.css`. Ele define as ~19 variáveis que o plugin herdava do Obsidian (`--background-primary`, `--text-muted`, `--interactive-accent`, etc.) porque as regras foram portadas de lá. Você pode manter esses nomes ou abandoná-los — não há mais nada dependendo deles no web.

Restrições reais:

- **Sem CDN.** O SPA é servido pelo servidor kanban em `127.0.0.1:9375`. Fontes e assets precisam ser locais ou embutidos.
- **Densidade importa.** É um board kanban operado junto com agentes: muitos cards, colunas lado a lado, leitura rápida de estado. Não é uma landing page.
- **Tema claro e escuro.** O atual usa `prefers-color-scheme`. Manter os dois.
- **O conteúdo dos cards é markdown rico** — MathJax e mermaid renderizam dentro do card detail. A tipografia precisa acomodar isso sem ficar apertada.

Carregue a skill `frontend-design` antes de decidir direção visual. Se for construir gráficos para o painel de custo, carregue `dataviz` antes de escrever a primeira linha de chart.

---

## Como verificar o que você fizer

**Isto é o mais importante deste documento.** Nas três fases anteriores eu não consegui abrir a interface em browser — a extensão do Chrome não estava conectada — e isso deixou passar três bugs que só apareceram quando o usuário abriu a tela:

1. O filtro de sprint vinha sempre vazio, porque eu li `sprints` da resposta de `kanban_list_projects`, que não tem esse campo.
2. O board aparecia vazio, porque `kanban_list_cards` esconde arquivados por padrão e eu não portei o toggle `showArchived` que o plugin tinha. No vault real do usuário, os 30 cards de `avare` estão todos arquivados.
3. O tipo de retorno de `kanban_create_project` declarava um subconjunto do que a tool devolve.

Os três têm a mesma origem: **escrevi a suposição na assinatura do método em vez de verificar contra o servidor.** Ao declarar um campo que a API não retorna, o TypeScript passa a confirmar a crença errada em vez de confrontá-la.

Então:

- **Tente o browser primeiro.** `mcp__claude-in-chrome__*` via ToolSearch. Se conectar, use — screenshots e interação real valem mais que qualquer teste que você escreva.
- **Se não conectar, diga isso explicitamente no relatório**, e não deixe implícito que a UI foi validada.
- **Verifique toda forma de resposta contra o servidor rodando** antes de escrever o tipo. Suba o servidor contra uma cópia do `test-vault/` e chame a tool com `curl`. Nunca derive o tipo do que parece razoável.
- Testes de cliente com `fetch` stubado existem em `packages/web/tests/client.test.ts` e travam os parâmetros enviados. Estenda esse padrão.

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

- **`kanban-token create --role agent` sempre grava `agent_type: 'pm'`.** Não existe flag `--agent-type` no CLI. Só a tool MCP `kanban_create_agent_token` minta um token dev de verdade. Já perdi tempo com um "dev token" que era pm disfarçado e passava onde devia falhar.
- **`packages/shared` compila para CommonJS** porque o servidor é CJS. O Vite precisa de `commonjsOptions.include` apontando para ele, senão exports de runtime como `parseSections` somem no build. Já está configurado em `packages/web/vite.config.ts` — não remova.
- **Não toque em `packages/plugin`.** Ele está congelado e é o rollback natural até a fase 5.
- **O servidor é a autoridade.** Regras de negócio replicadas no cliente são hint de UX, nunca decisão. O 409 do servidor é que manda. Ver `packages/web/src/App.tsx`, `moveHint`.
- **`pnpm install --filter <pkg>` desconfigura o `node_modules` dos outros pacotes.** Use `pnpm install` sem filtro.

---

## Pendências do usuário, não suas

- `KANBAN_DEV_TOKEN` e `KANBAN_PM_TOKEN` não estão no `.env`. Sem eles o sprint workflow encerra com exit 2. Só o usuário pode gerar (precisa do token de manager contra o vault real).
- O branch `web-migration` não foi mergeado na `main`.
