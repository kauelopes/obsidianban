# 02 — Arquitetura

## Diagrama de Camadas

```
┌──────────────────────────────────────────────────────────────┐
│  TRANSPORTE MCP                                              │
│  src/server/stdio.ts        src/server/http.ts               │
│  src/server/mcp-http.ts     src/server/idempotency.ts        │
│  src/server/sse.ts (SSEEventBus — replay 100 eventos)        │
│  src/server/tool-access.ts  src/server/tool-catalog.ts       │
├──────────────────────────────────────────────────────────────┤
│  SERVIÇOS DE DOMÍNIO                                         │
│  src/services/card.ts        src/services/sprint.ts          │
│  src/services/admin.ts       src/services/query.ts           │
│  src/services/metrics.ts     src/services/workflow-runner.ts │
├──────────────────────────────────────────────────────────────┤
│  CARDS / VAULT                                               │
│  src/cards/repository.ts     src/cards/serialize.ts          │
│  src/cards/slug.ts           src/vault/layout.ts             │
│  src/watcher/file-watcher.ts src/startup/reconcile.ts        │
├──────────────────────────────────────────────────────────────┤
│  PERSISTÊNCIA                                                │
│  src/db/database.ts (SQLite)   src/writer/atomic.ts          │
│  <vault>/kanban-data/**/*.md   <vault>/.kanban/audit.ndjson  │
└──────────────────────────────────────────────────────────────┘
              ▲ SSE (push de eventos)
┌──────────────────────────────────────────────────────────────┐
│  PLUGIN OBSIDIAN                                             │
│  plugin/src/mcp/client.ts        (chamadas HTTP)             │
│  plugin/src/mcp/sse-subscriber.ts (consumidor SSE)           │
│  plugin/src/view/                (render Kanban)             │
└──────────────────────────────────────────────────────────────┘
```

---

## Diagrama de Componentes

```
┌──────────────┐   Bearer token   ┌─────────────────────────┐
│   Agente IA  │ ────────────────▶│  MCP Server (HTTP/stdio) │
│ (Claude/PM)  │◀─────────────── │  src/index.ts            │
└──────────────┘   tool results   └────────────┬────────────┘
                                               │ lê/escreve
                                  ┌────────────▼────────────┐
                                  │   Vault Obsidian         │
                                  │  kanban-data/**/*.md     │
                                  │  .kanban/db.sqlite       │
                                  └────────────┬────────────┘
                                               │ SSE push
                                  ┌────────────▼────────────┐
                                  │   Plugin Obsidian        │
                                  │  Board view + editor     │
└──────────────┐                  └─────────────────────────┘
│   Humano     │ ── edita .md ──▶  file-watcher detecta
│ (Obsidian)   │                   → CARD_HUMAN_EDITED SSE
└──────────────┘
```

---

## Controle de Acesso por Role

| Role | Origem | Escopo | Capacidades |
|------|--------|--------|-------------|
| `manager` | `.kanban/manager-tokens.json` | Vault inteiro | Todas as operações + criar projetos, arquivar projetos, criar tokens de agente |
| `pm` (agent) | `_meta.json` do projeto | Projeto específico | Criar cards, atualizar cards, mover, reordenar, criar/gerenciar sprints |
| `dev` (agent) | `_meta.json` do projeto | Projeto específico | `kanban_log_on_card` apenas; sem criação/update de campos |

Tokens legados sem `agent_type` são tratados como `pm`.

---

## Decisões Arquiteturais Chave

### 1. `.md` como fonte de verdade

Cards são persistidos em arquivos Markdown com frontmatter YAML. O SQLite é um índice derivado — reconstruído via `src/startup/reconcile.ts` se necessário. Isso permite que humanos editem cards diretamente no Obsidian e que o sistema se recupere de falhas do banco sem perda de dados.

**Trade-off:** Leituras frequentes de arquivo em operações que precisam do `body` do card (7 chamadas `readFile+parseCardFile` em `card.ts`).

### 2. Escrita Atômica

`src/writer/atomic.ts` escreve em `<nome>.tmp` e depois faz `rename` atômico. Garante que leituras concorrentes nunca vejam um arquivo parcialmente escrito.

### 3. Versionamento Otimista

Cada card tem um campo `version` incrementado a cada mutação. Escritas verificam a versão antes de persistir e retornam 409 (com `current_card` no body) se divergente. Isso elimina locks sem sacrificar consistência.

### 4. Replay SSE

O `SSEEventBus` mantém um buffer rolling dos últimos 100 eventos. Clientes que reconectam com `Last-Event-ID: N` recebem eventos perdidos sem precisar de fetch completo do estado.

### 5. Idempotência

Operações de mutação aceitam `request_id` opcional. O `src/server/idempotency.ts` persiste a resposta da primeira execução em `idempotency.json` e a devolve para requests repetidos, prevenindo duplicações em retries de rede.

### 6. Reconciliação na Inicialização

`src/startup/reconcile.ts` compara checksums SHA-256 dos `.md` com o banco ao iniciar. Cards novos são inseridos, cards editados externamente são atualizados, e registros órfãos são removidos. Garante consistência mesmo após edições manuais enquanto o servidor estava parado.

---

## Fluxo de Dados — Mutação de Card (ex: `kanban_move_card`)

```
Plugin / Agente
    │
    │ POST /mcp  (Bearer token)
    ▼
src/server/http.ts → valida token (auth/validator.ts)
    │
    ▼
src/server/mcp-http.ts → verifica idempotência (idempotency.ts)
    │
    ▼
src/server/tool-access.ts → verifica permissão por role
    │
    ▼
src/services/card.ts#moveCard()
    ├── repo.findById() ──▶ SQLite
    ├── verifica version (409 se divergente)
    ├── repo.maxPosition() ──▶ SQLite
    ├── atomicWriter.write() ──▶ .md file (via .tmp + rename)
    ├── repo.update() ──▶ SQLite
    ├── auditLogger.log() ──▶ audit.ndjson
    └── sseBus.emit(CARD_MOVED) ──▶ todos SSE clients
    │
    ▼
200 OK { card: Card }
    │
    ▼ (paralelo, via SSE)
plugin/src/mcp/sse-subscriber.ts recebe CARD_MOVED
    └── atualiza board view
```

---

## Fluxo de Detecção de Edição Humana

```
Humano edita .md no Obsidian
    │
    ▼
src/watcher/file-watcher.ts (chokidar)
    │
    ▼
compara SHA-256 do arquivo com hash no banco
    │ (divergiu)
    ▼
src/cards/serialize.ts#cardFromFrontmatter()
    │
    ├── repo.update() (incrementa version, atualiza campos)
    └── sseBus.emit(CARD_HUMAN_EDITED) ──▶ plugin atualiza board
```
