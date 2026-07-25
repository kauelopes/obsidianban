# packages/server — obsidiankan-mcp

MCP Server do ObsidianKan. Expõe 27 ferramentas MCP para gerenciar um sistema Kanban persistido em arquivos Markdown dentro de um vault Obsidian.

## Entry points

| Arquivo | Descrição |
|---|---|
| `src/index.ts` | Servidor HTTP na porta 9375 (padrão) ou modo stdio (`--stdio`) |
| `src/auth/cli.ts` | CLI `kanban-token` para gerar tokens de manager |

## Variáveis de ambiente

| Variável | Obrigatória | Padrão | Descrição |
|---|:---:|---|---|
| `VAULT_PATH` | ✅ | — | Caminho absoluto para o vault Obsidian |
| `MCP_HTTP_PORT` | ❌ | `9375` | Porta HTTP |
| `LOG_LEVEL` | ❌ | `info` | `debug` \| `info` \| `warn` \| `error` |
| `WORKFLOW_ENABLED` | ❌ | `false` | Ativa auto-launch do sprint workflow |

Referência completa: [docs/reference/config.md](../../docs/reference/config.md)

## Comandos

```bash
# Build (TypeScript → dist/)
pnpm build

# Executar
pnpm start

# Dev mode com hot reload (tsx watch)
pnpm dev

# Testes
pnpm test
pnpm test:watch
pnpm test:coverage

# Type check
pnpm typecheck

# Gerar catálogo de tools
pnpm gen:tools
```

## Estrutura de src/

```
src/
├── index.ts          # Entry point: inicializa servidor, registra tools
├── config.ts         # Config loader (paths, port, log level)
├── auth/             # Validação JWT, CLI de tokens
├── audit/            # Audit log append-only (NDJSON)
├── cards/            # Repositório SQLite + serialização Markdown
├── db/               # Conexão SQLite, schema
├── server/           # HTTP (node:http), SSE bus, MCP protocol, RBAC
├── services/         # Lógica de negócio (13 arquivos)
│   ├── card.ts       # Façade de card (317 linhas)
│   ├── card-reader.ts
│   ├── card-writer.ts
│   ├── card-mover.ts
│   ├── card-blocker.ts
│   ├── card-shared.ts
│   ├── sprint.ts
│   ├── query.ts
│   ├── admin.ts
│   ├── metrics.ts
│   ├── validation.ts
│   ├── errors.ts
│   └── workflow-runner.ts
├── startup/          # Reconciliação vault → SQLite
├── util/             # Logger (pino), constantes
├── vault/            # Leitura/escrita de .md com YAML frontmatter
├── watcher/          # Chokidar — detecta edições humanas
└── writer/           # Escritas atômicas (.tmp → rename)
```

## Testes

267 testes em `tests/` organizados em:
- `unit/` — funções puras e classes isoladas (10 arquivos)
- `service/` — serviços com SQLite in-memory real (6 arquivos)
- `integration/` — fluxos HTTP end-to-end (1 arquivo)
- `helpers/` — factories, test vault, test client

Ver guia completo: [docs/for-developers/testing.md](../../docs/for-developers/testing.md)
