# ObsidianKan — CLAUDE.md

**ObsidianKan** é um servidor MCP que expõe um sistema Kanban persistido em arquivos Markdown dentro de um vault Obsidian. Inclui um plugin Obsidian para visualização e um workflow autônomo de sprint com agentes de IA.

---

## Estrutura do monorepo

```
packages/
  server/    # obsidiankan-mcp — MCP Server principal
    scripts/ # sprint-workflow.ts — orquestrador autônomo de sprint
  web/       # @obsidiankan/web — SPA React (board + card detail)
  plugin/    # @obsidiankan/plugin — Plugin Obsidian (congelado, sai na fase 5)
  shared/    # @obsidiankan/types — Tipos + parser de zonas do card
```

**Gerenciador de pacotes:** pnpm (workspace). Em shells não-interativos, usar `~/.local/share/pnpm/bin/pnpm`.

---

## Entry points

| Arquivo | Descrição |
|---|---|
| `packages/server/src/index.ts` | MCP Server — modo HTTP (padrão) ou stdio (`--stdio`) |
| `packages/server/src/auth/cli.ts` | CLI para gerar tokens (`kanban-token generate-token`) |
| `packages/plugin/src/main.ts` | Plugin Obsidian — views, comandos, SSE subscriber |
| `packages/server/scripts/sprint-workflow.ts` | Workflow autônomo — orquestra PM + Dev agents |

---

## Variáveis de ambiente obrigatórias

```bash
VAULT_PATH=/caminho/para/vault   # Vault Obsidian
MCP_HTTP_PORT=9375               # Porta do servidor (padrão 9375)
```

Referência completa em `docs/reference/config.md`.

---

## Build e testes

```bash
# Build (shared → server, nessa ordem)
~/.local/share/pnpm/bin/pnpm run build

# Build do SPA web (servido pelo servidor na mesma origem)
~/.local/share/pnpm/bin/pnpm run build:web

# Build do plugin Obsidian
~/.local/share/pnpm/bin/pnpm run build:plugin

# Testes (525 no workspace: 371 server + 41 plugin + 113 web)
~/.local/share/pnpm/bin/pnpm run test
~/.local/share/pnpm/bin/pnpm run test:watch
~/.local/share/pnpm/bin/pnpm run test:coverage

# Type check de todos os pacotes
~/.local/share/pnpm/bin/pnpm run typecheck

# Dev mode (hot reload)
~/.local/share/pnpm/bin/pnpm --filter obsidiankan-mcp run dev

# Regenerar catálogo de tools MCP
~/.local/share/pnpm/bin/pnpm run gen:tools
# → docs/for-agents/tool-catalog.md
```

---

## Subsistemas do server (packages/server/src/)

| Pasta | Responsabilidade |
|---|---|
| `auth/` | Validação de tokens JWT, CLI de geração |
| `cards/` | Repositório SQLite de cards, sincronização |
| `db/` | Conexão SQLite, schema, migrations |
| `server/` | HTTP (`node:http` cru), SSE, MCP protocol, RBAC, tool catalog |
| `services/` | Lógica de negócio — card, sprint, query, admin, metrics |
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
