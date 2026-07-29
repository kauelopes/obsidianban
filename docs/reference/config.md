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

O disparo **manual** (`kanban_workflow_start`, ou o botão "Executar agentes" na
web) funciona sem nenhuma variável: o servidor resolve o script e o diretório
de log pelos defaults abaixo. `WORKFLOW_ENABLED` controla apenas o
**auto-launch** ao iniciar uma sprint.

| Variável | Padrão | Descrição |
|---|---|---|
| `WORKFLOW_ENABLED` | `false` | Ativa auto-launch do sprint workflow ao iniciar uma sprint (`kanban_start_sprint`) |
| `WORKFLOW_SCRIPT_PATH` | `packages/server/scripts/sprint-workflow.ts` | Path do script do workflow, resolvido relativo ao pacote do servidor. Um path `.js`/`.mjs` roda sem o loader tsx |
| `WORKFLOW_LOG_DIR` | `<vault>/.kanban/workflow-logs` | Diretório dos logs por sprint (`sprint-<id>.log`) — servidos pela rota `GET /workflow/log` |
| `ANTHROPIC_API_KEY` | — | API key Anthropic para o LLM de triagem e dev harness |
| `KANBAN_PM_TOKEN` | — | Override opcional do token PM. Sem ele, o servidor lê `KANBAN_TOKEN` do `.claude/settings.local.json` do `target_repo` (gravado pelo provisionamento de `kanban_set_project_repo`) |
| `KANBAN_DEV_TOKEN` | — | Override opcional do token Dev — mesmo fallback via `KANBAN_DEV_TOKEN` do settings do repo |

Scripts `.ts` são lançados com `node --import tsx`.

O diretório de trabalho do dev harness **não** vem do ambiente: é o `target_repo` do projeto, definido por `kanban_set_project_repo`. Não existe fallback global.

Sem token pm **e** dev resolvíveis (ambiente ou settings do repo), `kanban_workflow_start` falha com `400 workflow_tokens_missing` antes de spawnar qualquer processo.

**Contabilidade de tokens — nenhum round se perde.** Todo round do workflow
(dev ou triagem, com ou sem card atribuído, inclusive rounds que falham)
registra o usage medido via `kanban_log_workflow_usage`: input/output, tokens
de cache (que ficam **fora** de input/output no usage do harness), `cost_usd`
autoritativo (`total_cost_usd` do harness) e turnos. Os registros caem no
`token_log` (op `WORKFLOW_DEV`/`WORKFLOW_TRIAGE`, com `sprint_id`) e o
`/metrics` agrega tudo — o painel da web mostra o custo medido e rebaixa a
estimativa por tokens a referência. A anotação por card (`DEV_DRAIN_LIMIT=1`)
continua existindo como refinamento, agora também com cache e usd.

O ciclo de vida de uma execução é observável por `kanban_workflow_status`
(running/exited/failed/stopped), pelos eventos SSE `WORKFLOW_STARTED` /
`WORKFLOW_EXITED` e pelo log incremental em `GET /workflow/log?sprint_id=&offset=`
(loopback-only, sem token, como `/metrics`). `kanban_workflow_stop` envia
SIGTERM ao process group inteiro — o workflow e os harnesses dev que ele
spawnou. O estado vive em memória: após um restart do servidor o processo
antigo não é mais rastreado, mas o log em disco continua legível.

### Wizard de planejamento (opcional)

| Variável | Padrão | Descrição |
|---|---|---|
| `PLANNING_MODEL` | — | Override de modelo do `claude` headless; ausente herda o default do harness |
| `PLANNING_TURN_TIMEOUT_MS` | `240000` | Kill do turno headless após esse tempo. As etapas `sprints_tasks` e `review` geram respostas grandes — para projetos com muitos épicos, use `900000` |
| `PLANNING_STUB` | `false` | **Modo de desenvolvimento**: `true`/`1` troca o LLM por respostas sintéticas instantâneas e gratuitas (`StubRunner`). Todas as telas do wizard funcionam, incluindo refine, retry e materialização. Nunca usar em produção — o conteúdo gerado é placeholder |

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
