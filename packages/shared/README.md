# packages/shared — @obsidiankan/types

Tipos TypeScript compartilhados entre o MCP Server (`packages/server`) e o web app (`packages/web`).

## O que exporta

Todas as definições em `src/index.ts`:

| Tipo / Interface | Descrição |
|---|---|
| `Card` | Card completo com 22 campos (id, title, status, version, body, ...) |
| `CardSummary` | Card sem o campo `body` (para listagens) |
| `Sprint` | Sprint com status planning/active/closed |
| `Priority` | `'low' \| 'medium' \| 'high' \| 'critical'` |
| `AgentToken` | Token de agente (role:'agent', agent_type:'pm'\|'dev') |
| `ManagerToken` | Token de manager (role:'manager') |
| `CreateCardParams` | Parâmetros da tool `kanban_create_card` |
| `UpdateCardParams` | Parâmetros da tool `kanban_update_card` |
| `MoveCardParams` | Parâmetros da tool `kanban_move_card` |
| `ListCardsParams` | Filtros da tool `kanban_list_cards` |
| `SSEEvent` | Union type com os 14 tipos de eventos SSE |
| `AuditOp` | Tipos de operação do audit log |
| `AuditEntry` | Entrada do audit log |
| `ConflictError` | Erro de conflito de versão (409) |
| `ValidationError` | Erro de validação de campo (400) |
| `BoardData` | Dados do board para o web app (cards agrupados por coluna) |
| `Metrics` | Métricas de uso de tokens |

## Como usar

```typescript
import { Card, Sprint, AgentToken, SSEEvent } from '@obsidiankan/types'

const card: Card = {
  id: 'card-abc123',
  title: 'Meu card',
  status: 'todo',
  // ...
}
```

## Build

```bash
# Compilar (TypeScript → dist/)
pnpm build

# O output em dist/ inclui:
# dist/index.js      — módulo CommonJS
# dist/index.d.ts    — declarações de tipos
# dist/index.d.ts.map — source maps de declarações
```

**Importante:** sempre compile o shared antes do server ou web. O build raiz (`pnpm run build`) garante a ordem correta via TypeScript project references.

## Alterar tipos

Após qualquer alteração em `src/index.ts`:

```bash
# Recompilar shared
pnpm build

# Recompilar dependentes
pnpm --filter obsidiankan-mcp build
pnpm --filter @obsidiankan/web build
```
