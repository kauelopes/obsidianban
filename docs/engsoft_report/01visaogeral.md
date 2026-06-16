# 01 — Visão Geral

## Propósito

O ObsidianKan MCP é uma board Kanban persistida em arquivos Markdown dentro de um vault Obsidian, exposta via protocolo MCP (Model Context Protocol). Permite que agentes de IA (Claude) e humanos compartilhem o mesmo board: agentes criam e movem cards via ferramentas MCP; humanos editam os arquivos `.md` diretamente no Obsidian. Um plugin Obsidian dedicado fornece a visualização em colunas e consome o mesmo servidor MCP via SSE para atualizações em tempo real.

---

## Stack Tecnológica

| Componente | Tecnologia | Versão |
|------------|-----------|--------|
| Runtime | Node.js | ≥ 22 |
| Linguagem | TypeScript | 5.6 |
| Banco de dados | better-sqlite3 | ^11.5.0 |
| Protocolo | @modelcontextprotocol/sdk | ^1.29.0 |
| Parser de frontmatter | gray-matter | ^4.0.3 |
| Watcher de arquivos | chokidar | ^4.0.1 |
| Geração de IDs | nanoid | ^5.0.7 |
| SDK do agente | @anthropic-ai/sdk | ^0.102.0 |
| Build do plugin | esbuild | ^0.28.0 (devDep) |
| Transpiler dev | tsx | ^4.19.2 (devDep) |

---

## Estrutura de Diretórios

```
obsidiankan-mcp/
├── src/                        # Servidor MCP (Node.js)
│   ├── index.ts                # Entry point: inicia HTTP ou stdio
│   ├── config.ts               # Leitura de variáveis de ambiente, paths derivados
│   ├── types.ts                # Interfaces normativas (fonte de verdade dos contratos)
│   ├── server/                 # Transporte e roteamento MCP
│   │   ├── http.ts             # Servidor HTTP com autenticação Bearer
│   │   ├── stdio.ts            # Transporte stdio (Claude desktop)
│   │   ├── mcp-http.ts         # Handler MCP sobre HTTP
│   │   ├── sse.ts              # SSEEventBus (pub/sub em memória, replay 100 eventos)
│   │   ├── tool-catalog.ts     # Registro de ferramentas MCP
│   │   ├── tool-schemas.ts     # Schemas JSON dos parâmetros
│   │   ├── tool-access.ts      # Controle de acesso por role
│   │   └── idempotency.ts      # Deduplicação por request_id
│   ├── services/               # Lógica de domínio
│   │   ├── card.ts             # CardService (1393 linhas — god object)
│   │   ├── sprint.ts           # SprintService
│   │   ├── admin.ts            # Operações de projeto (arquivar, deletar)
│   │   ├── query.ts            # Consultas de listagem e métricas
│   │   ├── metrics.ts          # Agregação de tokens e operações
│   │   ├── workflow-runner.ts  # Lançamento do agente workflow como processo filho
│   │   ├── validation.ts       # Helpers de validação de campos
│   │   └── errors.ts           # Fábrica de HttpError
│   ├── auth/                   # Autenticação
│   │   ├── tokens.ts           # Criação e verificação de tokens (SHA-256)
│   │   ├── validator.ts        # Middleware de validação de Bearer token
│   │   └── cli.ts              # CLI `kanban-token` para emissão de tokens
│   ├── cards/                  # Persistência de cards
│   │   ├── repository.ts       # CardRepository (SQLite CRUD)
│   │   ├── serialize.ts        # Serialização/deserialização frontmatter ↔ Card
│   │   └── slug.ts             # Geração de slugs únicos para nomes de arquivo
│   ├── vault/
│   │   └── layout.ts           # Leitura da estrutura do vault (_meta.json, listagem)
│   ├── db/
│   │   ├── database.ts         # Abertura e migração do banco SQLite
│   │   └── schema.ts           # DDL e migrations
│   ├── writer/
│   │   └── atomic.ts           # Escrita atômica via arquivo .tmp + rename
│   ├── watcher/
│   │   └── file-watcher.ts     # Watcher chokidar → detecção de edições humanas
│   ├── startup/
│   │   └── reconcile.ts        # Sincronização DB ↔ .md na inicialização
│   └── audit/
│       └── logger.ts           # Append-only de AuditEntry em NDJSON
│
├── plugin/                     # Plugin Obsidian
│   ├── src/
│   │   ├── main.ts             # Entry point do plugin
│   │   ├── settings.ts / settings-tab.ts
│   │   ├── mcp/
│   │   │   ├── client.ts       # Cliente HTTP MCP
│   │   │   └── sse-subscriber.ts # Consumidor SSE (reconexão automática)
│   │   ├── view/               # BoardView (renderização Kanban)
│   │   ├── ui/                 # Componentes de UI
│   │   └── editor/             # Integração com editor Obsidian
│   └── esbuild.config.mjs      # Build do plugin
│
├── scripts/                    # Utilitários e testes manuais
│   ├── sprint-workflow.ts      # Agente de workflow (Claude + MCP)
│   ├── smoke-*.mjs             # Scripts de smoke test manuais
│   └── _batch*.ts              # Runners de batch para testes de carga
│
└── docs/                       # Documentação
    ├── architecture/           # Diagramas e histórico de sprints
    ├── design/                 # Interfaces normativas e especificações
    └── prd/                    # PRD e backlog
```

---

## Entry Points

| Arquivo                      | Propósito                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`               | Inicialização do servidor: detecta modo (HTTP vs stdio), carrega config, inicia reconciliação, monta transporte MCP |
| `src/auth/cli.ts`            | CLI `kanban-token`: emite tokens de agente (pm/dev) e manager                                                       |
| `plugin/src/main.ts`         | Plugin Obsidian: registra vistas, conecta ao servidor MCP, inicia SSE                                               |
| `scripts/sprint-workflow.ts` | Agente autônomo que gerencia sprints via Claude + ferramentas MCP                                                   |

---

## Configuração (Variáveis de Ambiente)

| Variável | Obrigatória | Padrão | Descrição |
|----------|-------------|--------|-----------|
| `VAULT_PATH` | **Sim** | — | Caminho absoluto para o vault Obsidian |
| `MCP_HTTP_PORT` | Não | `9375` | Porta do servidor HTTP |
| `LOG_LEVEL` | Não | `info` | Nível de log (`debug`/`info`/`warn`/`error`) |
| `WORKFLOW_ENABLED` | Não | — | `true` para habilitar auto-launch do workflow |
| `WORKFLOW_SCRIPT_PATH` | Cond. | — | Caminho absoluto para `sprint-workflow.ts` (requer `WORKFLOW_ENABLED=true`) |
| `WORKFLOW_LOG_DIR` | Não | — | Diretório para logs por sprint do workflow |
| `ANTHROPIC_API_KEY` | Cond. | — | Necessária quando `WORKFLOW_ENABLED=true` |
| `KANBAN_DEV_TOKEN` | Cond. | — | Token dev para o agente workflow |
| `KANBAN_PM_TOKEN` | Cond. | — | Token pm para o agente workflow |

---

## Paths derivados do vault

| Path | Conteúdo |
|------|----------|
| `<vault>/kanban-data/<projeto>/` | Cards `.md` (visível ao Obsidian) |
| `<vault>/kanban-data/<projeto>/_meta.json` | Colunas e tokens de agente do projeto |
| `<vault>/.kanban/db.sqlite` | Índice SQLite derivado |
| `<vault>/.kanban/audit.ndjson` | Trilha de auditoria append-only |
| `<vault>/.kanban/idempotency.json` | Store de idempotência por `request_id` |
| `<vault>/.kanban/manager-tokens.json` | Tokens de manager (não ligados a projeto) |
