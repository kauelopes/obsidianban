# Referência de Configuração — ObsidianKan

Todas as variáveis de ambiente e arquivos de configuração.

---

## Variáveis de ambiente

Copie `.env.example` para `.env` e edite conforme necessário.

### Obrigatórias

| Variável | Tipo | Descrição |
|---|---|---|
| `VAULT_PATH` | path absoluto | Caminho para o vault Obsidian no host. Ex: `/home/user/Documents/MeuVault` |

### Servidor HTTP

| Variável | Padrão | Descrição |
|---|---|---|
| `MCP_HTTP_PORT` | `9375` | Porta do servidor HTTP. Bind em `127.0.0.1` (não exposto externamente). |
| `LOG_LEVEL` | `info` | Nível de log pino: `debug` \| `info` \| `warn` \| `error` |

### Workflow autônomo (opcional)

Requer `claude` CLI no PATH e tokens válidos.

| Variável | Padrão | Descrição |
|---|---|---|
| `WORKFLOW_ENABLED` | `false` | Ativa auto-launch do sprint workflow ao iniciar uma sprint |
| `WORKFLOW_SCRIPT_PATH` | — | Path absoluto para `packages/server/scripts/sprint-workflow.ts`. **Sem default:** se `WORKFLOW_ENABLED=true` e esta variável não estiver definida, o auto-launch é desligado com um `logger.warn` e a sprint inicia sem workflow |
| `WORKFLOW_LOG_DIR` | — | Diretório para logs por sprint. Ex: `<vault>/.sprint-logs` |
| `ANTHROPIC_API_KEY` | — | API key Anthropic para o LLM de triagem e dev harness |
| `KANBAN_PM_TOKEN` | — | Token PM (gerado via `kanban_create_agent_token`) |
| `KANBAN_DEV_TOKEN` | — | Token Dev (gerado via `kanban_create_agent_token`) |

O script é lançado com `node --import tsx`, por isso `WORKFLOW_SCRIPT_PATH` aponta para o `.ts` fonte — o build não emite `scripts/` (o `tsconfig.json` do server usa `rootDir: src`).

O diretório de trabalho do dev harness **não** vem do ambiente: é o `target_repo` do projeto, definido por `kanban_set_project_repo`. Não existe fallback global.

`KANBAN_PM_TOKEN` e `KANBAN_DEV_TOKEN` são obrigatórios — o workflow encerra com exit 2 se algum faltar.

---

## Arquivo `.mcp.json`

Configuração do cliente MCP (Claude CLI / Claude Code):

```json
{
  "mcpServers": {
    "kanban": {
      "type": "http",
      "url": "http://127.0.0.1:9375/mcp",
      "headers": {
        "Authorization": "Bearer ${KANBAN_TOKEN}"
      }
    }
  }
}
```

`KANBAN_TOKEN` é lido do ambiente — defina com o token correto para o papel desejado (manager, pm ou dev).

---

## Estrutura do vault gerada pelo servidor

O servidor cria e gerencia automaticamente esta estrutura dentro do `VAULT_PATH`:

```
vault/
├── kanban-data/           # Visível e indexado pelo Obsidian
│   └── <project-slug>/    # Uma pasta por projeto
│       └── <card-slug>.md # Um arquivo .md por card
└── .kanban/               # Internos do servidor (ocultos)
    ├── db.sqlite           # Índice SQLite (derivado, pode ser deletado)
    ├── audit.ndjson        # Audit log append-only
    ├── idempotency.json    # Store de idempotência
    └── manager-tokens.json # Tokens de manager
```

**Importante:** `kanban-data/` é editável diretamente — o servidor detecta mudanças via file watcher e reconcilia automaticamente. `.kanban/` não deve ser editado manualmente.

---

## Paths internos (TypeScript)

Definidos em `packages/server/src/config.ts`:

```typescript
interface Paths {
  vault: string              // VAULT_PATH
  kanbanData: string         // vault/kanban-data
  kanbanInternal: string     // vault/.kanban
  sqlite: string             // .kanban/db.sqlite
  auditLog: string           // .kanban/audit.ndjson
  idempotencyStore: string   // .kanban/idempotency.json
  managerTokens: string      // .kanban/manager-tokens.json
}
```

---

## Plugin Obsidian

Configurações do plugin (Obsidian → Configurações → Plugins → ObsidianKan):

| Campo | Padrão | Descrição |
|---|---|---|
| URL base | `http://127.0.0.1:9375` | Endereço do MCP Server |
| Token de autenticação | — | Bearer token do agente (pm ou dev) |

### Variável de ambiente para desenvolvimento do plugin

```bash
# Define o vault alvo para o build do plugin
OBSIDIANKAN_DEV_VAULT=/caminho/para/seu/vault
~/.local/share/pnpm/bin/pnpm --filter @obsidiankan/plugin run dev
```
