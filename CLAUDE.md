# ObsidianKan — CLAUDE.md

**ObsidianKan** é um servidor MCP que expõe um sistema Kanban persistido em arquivos Markdown dentro de um vault Obsidian. Inclui um web app React para visualização e edição, e um workflow autônomo de sprint com agentes de IA.

---

## Estrutura do monorepo

```
packages/
  server/    # obsidiankan-mcp — MCP Server principal
    scripts/ # sprint-workflow.ts — orquestrador autônomo de sprint
  web/       # @obsidiankan/web — SPA React (board + card detail), servido pelo servidor na mesma origem
  shared/    # @obsidiankan/types — Tipos + parser de zonas do card
```

**Gerenciador de pacotes:** pnpm (workspace). Em shells não-interativos, usar `~/.local/share/pnpm/bin/pnpm`.

---

## Entry points

| Arquivo | Descrição |
|---|---|
| `packages/server/src/index.ts` | MCP Server — modo HTTP (padrão) ou stdio (`--stdio`) |
| `packages/server/src/auth/cli.ts` | CLI para gerar tokens (`kanban-token generate-token`) |
| `packages/web/src/App.tsx` | Web app — board, card detail, wizard de planejamento |
| `packages/server/scripts/sprint-workflow.ts` | Workflow autônomo — orquestra PM + Dev agents |

---

## Variáveis de ambiente obrigatórias

```bash
VAULT_PATH=/caminho/para/vault   # Vault Obsidian
MCP_HTTP_PORT=9375               # Porta do servidor (padrão 9375)

# Opcionais — wizard de planejamento (KAD)
PLANNING_MODEL=…                 # override de modelo do claude headless (default: o do harness)
PLANNING_TURN_TIMEOUT_MS=240000  # kill do turno headless após esse tempo
PLANNING_STUB=true               # dev: turnos sintéticos sem LLM e materialização simulada (nada é criado de verdade) — nunca em produção
```

Referência completa em `docs/reference/config.md`.

---

## Build e testes

```bash
# Build (shared → server, nessa ordem)
~/.local/share/pnpm/bin/pnpm run build

# Build do SPA web (servido pelo servidor na mesma origem)
~/.local/share/pnpm/bin/pnpm run build:web

# Testes
~/.local/share/pnpm/bin/pnpm run test
~/.local/share/pnpm/bin/pnpm run test:watch
~/.local/share/pnpm/bin/pnpm run test:coverage

# Type check de todos os pacotes
~/.local/share/pnpm/bin/pnpm run typecheck

# Dev mode (hot reload, foreground)
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev
# equivalente: make start_server (já carrega .env)

# Regenerar catálogo de tools MCP
~/.local/share/pnpm/bin/pnpm run gen:tools
# → docs/for-agents/tool-catalog.md
```

---

## Rodando o servidor de longa duração — SEMPRE via `make`

Nunca subir à mão (`node dist/index.js`, `nohup` improvisado): sem `.env`
carregado por inteiro, o auto-launch do workflow falha **silenciosamente**
(só um `logger.warn`) — causa raiz de um incidente real de sprint presa.

```bash
make server-start    # build + sobe em background, .env carregado (usar após boot da máquina)
make server-stop     # SIGTERM limpo (pidfile em .run/server.pid)
make server-restart  # stop + start
make server-status   # pid + GET /health
make server-logs     # tail -f do log (.run/server.log)
```

Sem autostart configurado (nem systemd nem cron) — depois de reiniciar a
máquina, rodar `make server-start` manualmente.

Depois de `server-restart`/reboot: se uma sprint já estava `active`, o
auto-launch não religa sozinho — precisa de `kanban_workflow_start` manual
(detalhes em `docs/for-developers/architecture.md` §A5/§A6).

---

## Subsistemas do server (packages/server/src/)

| Pasta | Responsabilidade |
|---|---|
| `auth/` | Validação de tokens JWT, CLI de geração |
| `cards/` | Repositório SQLite de cards, sincronização |
| `db/` | Conexão SQLite, schema, migrations |
| `server/` | HTTP (`node:http` cru), SSE, MCP protocol, RBAC, tool catalog |
| `services/` | Lógica de negócio — card, sprint, query, admin, metrics, epic, planning |
| `planning/` | Wizard KAD "Planejar um novo Projeto" (nível projeto) — motor de etapas, runner headless do claude (`--resume`), materialização épicos→sprints→cards |
| `sprint-planning/` | Wizard de planejamento de uma sprint específica (`kanban_sprint_planning_*`) — distinto de `planning/`, que é o wizard de projeto novo |
| `jobs/` | JobManager/JobStore — execução de comandos de longa duração administrados pelo servidor (ver `docs/for-developers/architecture.md` §A6) |
| `startup/` | Reconciliação vault → SQLite no startup |
| `util/` | Logger (pino), constantes |
| `vault/` | Leitura/escrita de arquivos .md do vault |
| `watcher/` | Chokidar — detecta edições humanas no vault |
| `writer/` | Escritas atômicas (.tmp → rename) |
| `audit/` | Audit log append-only (NDJSON) |

---

## Convenções de código

- **Logger:** sempre `import { logger } from '../util/logger.js'` — nunca `console.log`
- **Constantes:** valores mágicos em `src/util/constants.ts`
- **Erros:** usar tipos em `src/services/errors.ts` (`ConflictError`, `ValidationError`, `NotFoundError`)
- **Imports:** extensão `.js` obrigatória (NodeNext module resolution)
- **Sem comentários óbvios** — comente apenas o "por quê" não óbvio
- **Sem error handling desnecessário** — não adicione fallbacks para cenários impossíveis

---

## Documentação

- `docs/for-users/` — getting started, troubleshoot
- `docs/for-developers/` — setup, arquitetura, testes, contribuição
- `docs/for-agents/` — runbook, catálogo de tools, integration guide, sprint workflow
- `docs/reference/` — config, design specs
- `docs/archive/` — histórico: engsoft_report, PRD, sprints (não reflete estado atual)
