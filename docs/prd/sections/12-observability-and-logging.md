# 12. Observability and Logging


### 12.1  Audit Log Entry Format
| { "ts":"2025-05-03T14:22:05.412Z",   "op":"FIELD_REVERTED",   "project":"projeto-x",   "card_id":"card-abc123",   "actor":"watcher",   "reverted_fields": ["id", "version"],   "reason": "immutable_field_changed",   "version_after": 8 } |
| --- |

MCP mutating operations (`CREATE`, `UPDATE`, `MOVE`, `REORDER`) additionally include token tracking fields:

| { "ts":"2025-05-03T14:22:05.412Z",   "op":"MOVE",   "project":"projeto-x",   "card_id":"card-abc123",   "actor":"agent:codex-1",   "version": 8,   "from_status": "doing",   "to_status": "done",   "input_tokens": 3840,   "output_tokens": 512,   "model": "claude-opus-4-7" } |
| --- |

### 12.2  Audit Event Types
| Event | Trigger | Produced By | Token fields |
| --- | --- | --- | --- |
| CREATE | Card created via MCP | All actors | input_tokens, output_tokens, model |
| UPDATE | Fields updated via MCP | All actors | input_tokens, output_tokens, model |
| MOVE | Status transition via kanban_move_card | All actors | input_tokens, output_tokens, model |
| REORDER | Position changed via kanban_reorder_card | All actors | input_tokens, output_tokens, model |
| HUMAN_EDIT | Human direct edit reconciled by watcher | File watcher |
| FIELD_REVERTED | Immutable or invalid field reverted — includes reverted_fields and reason | File watcher |
| EXTERNAL_MUTATION | File change from sync tool detected — processed as human edit | File watcher |
| PARSE_ERROR | Corrupted .md file detected and reverted | File watcher |
| CONFLICT | 409 issued — both versions and conflicting_fields | MCP |
| AUTH_FAIL | 401 issued — token hash prefix logged | MCP |
| INVALID_FIELDS | 400 due to disallowed fields | MCP |
| RECONCILED | File changed while MCP was offline, reconciled on startup | Startup |
| ORPHAN_REMOVED | SQLite entry had no corresponding .md file | Startup |
| SQLITE_REBUILT | SQLite deleted or corrupted, rebuilt from .md files | Startup |
| TOKEN_CREATED | New agent token issued | CLI |
| TOKEN_REVOKED | Agent token revoked | CLI |
| IDEMPOTENT_HIT | Duplicate request_id — cached response returned | MCP |
| STARTUP | MCP start with version and vault path | MCP |
| SHUTDOWN | MCP graceful stop | MCP |

### 12.3  Token Metrics

A tabela `token_log` no SQLite é a fonte para todas as métricas de consumo. O endpoint HTTP `GET /metrics` do MCP server agrega os dados e os entrega ao plugin para exibição no painel.

**Agregações disponíveis:**

| Dimensão | Descrição |
| --- | --- |
| `summary` | Totais gerais: `total_input_tokens`, `total_output_tokens`, `total_ops` |
| `by_type` | Tokens agrupados por `card_type` — identifica quais tipos de trabalho são mais custosos |
| `by_day` | Tokens por dia — série temporal para acompanhar tendência de consumo |
| `by_model` | Tokens por modelo — compara custo entre diferentes LLMs |
| `by_agent` | Tokens por `actor` — identifica quais agentes consomem mais |
| `by_operation` | Tokens por tipo de operação (`CREATE`, `UPDATE`, `MOVE`, `REORDER`) |

Parâmetros opcionais: `from_date` e `to_date` (ISO 8601) para filtrar o período consultado.

O endpoint é somente leitura e não requer parâmetros de token na chamada.

### 12.5  Application Logs
- Structured JSON to stdout. Fields: ts, level, request_id, project, card_id, duration_ms.
- Sensitive data (raw tokens, card body) never logged.
- Default level: info. LOG_LEVEL=debug for verbose output.

