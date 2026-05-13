# Sprint 02 — Core MCP API

**Objetivo:** Implementar as 6 tools MCP com validação completa, respostas de erro padronizadas e audit log cobrindo todos os event types. Ao final, agentes conseguem criar, ler, atualizar, mover e reordenar cards com todas as garantias de concorrência e idempotência do PRD.

**Pré-requisito:** Sprint 01 concluído — atomic writer, SQLite, auth middleware e idempotency store operacionais.

**Critério de encerramento:** suite completa de testes de API passa sem UI — todos os 6 tools, conflict, field rejection, idempotência e audit log verificáveis via chamadas diretas ao MCP.

---

## Tasks

| ID | Título | Tipo |
|---|---|---|
| TASK-09 | Implementar `kanban_list_cards` | `implementation` |
| TASK-10 | Implementar `kanban_get_card` | `implementation` |
| TASK-11 | Implementar `kanban_create_card` | `implementation` |
| TASK-12 | Implementar `kanban_update_card` com rejeição de campos proibidos | `implementation` |
| TASK-13 | Implementar `kanban_move_card` | `implementation` |
| TASK-14 | Implementar `kanban_reorder_card` com normalização de posições | `implementation` |
| TASK-15 | Implementar resposta 409 Conflict completa | `implementation` |
| TASK-16 | Completar audit log para todos os event types | `implementation` |
| TASK-16b | Implementar SSE endpoint server-side (`GET /events`) | `implementation` |

---

## Task Details

### TASK-09: Implementar `kanban_list_cards`

**Tipo:** `implementation`

**Descrição:**
Retorna lista de cards do projeto do token autenticado. Servido **exclusivamente do SQLite** — zero leituras de `.md`. Retorna apenas campos de frontmatter (body excluído).

**Parâmetros:**
| Parâmetro | Tipo | Descrição |
|---|---|---|
| `status` | string, opcional | Filtrar por status |
| `tags` | string[], opcional | AND filter — todas as tags devem estar presentes |
| `assigned_to` | string, opcional | Filtrar por responsável |
| `limit` | integer, opcional | Padrão 50, máximo 200 |
| `offset` | integer, opcional | Paginação, padrão 0 |
| `order_by` | string, opcional | `position` (padrão) \| `updated_at` \| `priority` \| `due_date` |

**Definition of Done:**
- Resposta servida do SQLite sem nenhuma leitura de arquivo `.md`
- Cards de outros projetos nunca retornam (filtro por `project_id` do token)
- Ordenação padrão por `position ASC`
- Filtro AND para `tags` funcional

**Testes:**
- Listar cards de projeto com 200 cards → resposta em < 50ms
- Token do projeto X → nunca retorna cards do projeto Y
- `tags: ["backend", "auth"]` → retorna apenas cards com **ambas** as tags
- `limit=5, offset=10` → retorna cards 11–15 ordenados por `position`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-10: Implementar `kanban_get_card`

**Tipo:** `implementation`

**Descrição:**
Retorna card completo incluindo body. Lê o arquivo `.md` do disco (não SQLite) para garantir o estado mais recente. Cards de outros projetos retornam 404 — idêntico a não encontrado (BR-03).

**Parâmetros:**
| Parâmetro | Tipo | Descrição |
|---|---|---|
| `id` | string, obrigatório | ID do card |

**Definition of Done:**
- Body vem do `.md`, não do SQLite
- Card de outro projeto retorna 404 (não 403)
- Frontmatter e body parseados e retornados juntos

**Testes:**
- ID válido do projeto → card completo com body
- ID de outro projeto → 404
- ID inexistente → 404
- Editar body do `.md` diretamente → `get_card` reflete edição imediatamente

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-11: Implementar `kanban_create_card`

**Tipo:** `implementation`

**Descrição:**
Cria um novo card. MCP gera `id`, `version=1`, `position`, `created_at` e `created_by` — esses campos não são aceitos no payload. Usa o atomic writer da TASK-03.

**Parâmetros:**
| Parâmetro | Tipo | Descrição |
|---|---|---|
| `title` | string, obrigatório | Não-vazio, máx 200 chars |
| `type` | string, obrigatório | Livre — descreve a natureza do trabalho. Sem validação de enum. |
| `input_tokens` | integer, obrigatório | Tokens de entrada consumidos pelo agente para produzir esta chamada |
| `output_tokens` | integer, obrigatório | Tokens de saída gerados pelo agente para produzir esta chamada |
| `model` | string, obrigatório | Identificador do modelo utilizado (ex: `claude-opus-4-7`) |
| `status` | string, opcional | Padrão: primeira coluna do `_meta.json` |
| `priority` | string, opcional | `low\|medium\|high\|critical`. Padrão: `medium` |
| `tags` | string[], opcional | |
| `due_date` | string, opcional | `YYYY-MM-DD` |
| `assigned_to` | string, opcional | |
| `body` | string, opcional | Markdown livre |
| `agent_notes` | string, opcional | Máx 2000 chars |
| `request_id` | string, opcional | UUID v4 |

**Geração de ID:** `card-{nanoid(8)}`
**Posição:** `MAX(position WHERE project=X AND status=Y) + 1000`

**Definition of Done:**
- Campos do sistema no payload → 400 com `disallowed_fields`
- `status` padrão é a primeira coluna em `_meta.json` se omitido
- Campos inválidos (title vazio, status inexistente, due_date mal-formatado) → 400
- `type` ausente → 400
- `input_tokens` ou `output_tokens` ausentes ou negativos → 400
- `model` ausente ou vazio → 400
- Retry com mesmo `request_id` → resposta idêntica, apenas 1 arquivo criado, tokens não re-acumulados
- Audit log: entrada `CREATE` com `input_tokens`, `output_tokens`, `model`
- Frontmatter do card criado contém `type`, `total_input_tokens` e `total_output_tokens`

**Testes:**
- Criar card mínimo sem `type` → 400
- Criar card com `input_tokens: -1` → 400
- Criar card com todos os campos obrigatórios → `total_input_tokens` no frontmatter igual ao `input_tokens` enviado
- `status` de coluna inexistente → 400
- `id` no payload → 400 com `disallowed_fields: ["id"]`
- Retry com mesmo `request_id` → mesmo card, sem duplicata, `total_input_tokens` não duplicado

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-12: Implementar `kanban_update_card` com rejeição de campos proibidos

**Tipo:** `implementation`

**Descrição:**
Atualiza campos de um card. Usa optimistic concurrency: `version` deve bater com o estado atual do `.md`. Qualquer campo proibido para o actor no payload → request inteira rejeitada com 400 (sem ignorar silenciosamente).

**Parâmetros:**
| Parâmetro | Tipo | Descrição |
|---|---|---|
| `id` | string, obrigatório | |
| `version` | integer, obrigatório | Deve bater com versão atual |
| `input_tokens` | integer, obrigatório | Tokens de entrada consumidos pelo agente para produzir esta chamada |
| `output_tokens` | integer, obrigatório | Tokens de saída gerados pelo agente para produzir esta chamada |
| `model` | string, obrigatório | Identificador do modelo utilizado |
| `title` | string, opcional | Replace |
| `status` | string, opcional | Replace. Deve ser coluna válida |
| `priority` | string, opcional | Replace |
| `tags` | string[], opcional | Replace do array inteiro |
| `due_date` | string\|null, opcional | `null` limpa o campo |
| `assigned_to` | string\|null, opcional | `null` desassocia |
| `agent_notes` | string, opcional | Replace. Máx 2000 chars |
| `body` | string, opcional | Replace do body inteiro |
| `request_id` | string, opcional | UUID v4 |

**Campos por actor:**
- Agent (`role=agent`): `title, status, priority, tags, due_date, assigned_to, agent_notes, body`
- Manager (`role=manager`): acima + `owner`

**Comportamento de `status` com position:**
Se `status` for alterado via `update_card`, MCP aplica a mesma lógica de position do `move_card`: o card é reposicionado para `MAX(position na coluna destino) + 1000` (append to bottom). Isso garante comportamento idêntico independente de qual tool foi usada para a mudança de status (§5.4, §6.5).

**Definition of Done:**
- Campo proibido no payload → 400 com `disallowed_fields` (verificado antes do version check)
- `input_tokens`, `output_tokens` ou `model` ausentes → 400
- `version` incorreta sem campos proibidos → 409 com `current_card` e `conflicting_fields`
- Semântica Replace: sem append automático em nenhum campo
- Mudança de `status` via `update_card` → position recalculada (MAX+1000 na coluna destino), idêntico ao `move_card`
- Audit log: entrada `UPDATE` com `changed_fields`, `input_tokens`, `output_tokens`, `model`
- `total_input_tokens` e `total_output_tokens` no frontmatter acumulados após update bem-sucedido
- Manager token (`role=manager`): campo `owner` aceito; agent token: `owner` → 400

**Testes:**
- Agent token envia `owner` → 400 `disallowed_fields: ["owner"]`
- Manager token envia `owner` → aceito, campo atualizado
- `version` correta + campos válidos → versão+1, log `UPDATE` com tokens corretos
- `version` desatualizada → 409 com `current_card`
- `version` correta + `owner` com agent token → 400 (campos proibidos têm prioridade sobre version check)
- Retry com mesmo `request_id` → mesma resposta, version não incrementa, tokens não re-acumulados
- Após update: `total_input_tokens` no frontmatter = valor anterior + `input_tokens` desta chamada
- `update_card` com `status` diferente → card aparece no final da coluna destino (posição = MAX+1000)

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-13: Implementar `kanban_move_card`

**Tipo:** `implementation`

**Descrição:**
Move um card para outra coluna. Card é adicionado ao final da coluna destino (`MAX(position) + 1000`). Semanticamente equivale a um update de `status` + reposicionamento.

**Parâmetros:**
| Parâmetro | Tipo | Descrição |
|---|---|---|
| `id` | string, obrigatório | |
| `version` | integer, obrigatório | Deve bater com versão atual |
| `to_status` | string, obrigatório | Coluna destino válida |
| `input_tokens` | integer, obrigatório | Tokens de entrada consumidos pelo agente para produzir esta chamada |
| `output_tokens` | integer, obrigatório | Tokens de saída gerados pelo agente para produzir esta chamada |
| `model` | string, obrigatório | Identificador do modelo utilizado |
| `request_id` | string, opcional | UUID v4 |

**Definition of Done:**
- `to_status` inexistente em `_meta.json` → 400
- `input_tokens`, `output_tokens` ou `model` ausentes → 400
- `version` desatualizada → 409
- Card movido aparece no **final** da coluna destino
- Flag `MCP-originated` suprime reprocessamento pelo file watcher
- Audit log: entrada `MOVE` com `from_status`, `to_status`, `input_tokens`, `output_tokens`, `model`
- `total_input_tokens` e `total_output_tokens` no frontmatter acumulados após move bem-sucedido

**Testes:**
- Mover com version correta → status atualizado, `position = MAX+1000`, version+1, log `MOVE` com tokens
- Mover com version stale → 409 com `current_card`
- Mover para coluna inexistente → 400
- Após move: `total_input_tokens` no frontmatter = valor anterior + `input_tokens` desta chamada

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-14: Implementar `kanban_reorder_card` com normalização de posições

**Tipo:** `implementation`

**Descrição:**
Reposiciona um card dentro da sua coluna atual. Após a operação, normaliza **todos** os positions da coluna para múltiplos de 1000. Retorna `affected_cards` com todos os cards cuja position foi alterada.

**Parâmetros:**
| Parâmetro | Tipo | Descrição |
|---|---|---|
| `id` | string, obrigatório | |
| `version` | integer, obrigatório | Deve bater com versão atual |
| `after_card_id` | string\|null, obrigatório | Inserir após este card. `null` = mover para o topo |
| `input_tokens` | integer, obrigatório | Tokens de entrada consumidos pelo agente para produzir esta chamada |
| `output_tokens` | integer, obrigatório | Tokens de saída gerados pelo agente para produzir esta chamada |
| `model` | string, obrigatório | Identificador do modelo utilizado |
| `request_id` | string, opcional | UUID v4 |

**Normalização:** após o reorder, todos os cards da coluna recebem `position = 1000, 2000, 3000, ...` na ordem atual.

**Definition of Done:**
- `after_card_id` de card em outra coluna → 400
- `input_tokens`, `output_tokens` ou `model` ausentes → 400
- Após reorder, todos os positions são múltiplos de 1000
- Todos os cards afetados têm version incrementada e aparecem em `affected_cards`
- Audit log: entrada `REORDER` com `input_tokens`, `output_tokens`, `model`
- Apenas o card alvo tem `total_input_tokens` acumulado (os demais afetados são reposicionados, não recebem tokens)

**Testes:**
- Reordenar entre 5 cards → positions resultantes `1000, 2000, 3000, 4000, 5000`
- `after_card_id: null` → card vai para o topo (position 1000 após normalização)
- `after_card_id` de outro projeto/coluna → 400
- Todos os afetados em `affected_cards` com version correta
- Log `REORDER` contém os tokens da chamada; apenas o card alvo acumula no frontmatter

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-15: Implementar resposta 409 Conflict completa

**Tipo:** `implementation`

**Descrição:**
Quando `version` no payload não bate com a versão atual do `.md`, retornar 409 com diagnóstico completo para que o agente construa um retry informado.

**Schema:**
```json
{
  "error": "conflict",
  "message": "Version mismatch: expected 7, found 9",
  "your_version": 7,
  "current_version": 9,
  "conflicting_fields": ["status"],
  "current_card": { }
}
```

`conflicting_fields`: campos que o agente tentou alterar e que já mudaram desde a versão que ele leu.

**Definition of Done:**
- `current_card` inclui body (lido do `.md`)
- `conflicting_fields` lista apenas os campos realmente em conflito
- `your_version` e `current_version` sempre presentes e corretos

**Testes:**
- Agente lê v5, outro ator escreve (v6), agente envia update com v5 → 409 com `current_version: 6`
- `conflicting_fields` contém apenas os campos que mudaram e que o agente tentou alterar
- `current_card` no 409 tem o body mais recente

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-16: Completar audit log para todos os event types

**Tipo:** `implementation`

**Descrição:**
Toda mutação de qualquer origem produz uma entrada no `audit.ndjson`. Arquivo append-only, formato NDJSON. Dados sensíveis (tokens raw, body de card) **nunca** são logados.

**Event types:**
| Tipo | Origem | Campos obrigatórios |
|---|---|---|
| `CREATE` | MCP agent | `ts, op, actor, project, card_id, version, input_tokens, output_tokens, model` |
| `UPDATE` | MCP agent | `ts, op, actor, project, card_id, version, changed_fields, input_tokens, output_tokens, model` |
| `MOVE` | MCP agent/plugin | `ts, op, actor, project, card_id, version, from_status, to_status, input_tokens, output_tokens, model` |
| `REORDER` | MCP agent/plugin | `ts, op, actor, project, card_id, version, affected_cards, input_tokens, output_tokens, model` |
| `HUMAN_EDIT` | File watcher | `ts, op, actor, project, card_id, version` |
| `FIELD_REVERTED` | File watcher | `ts, op, project, card_id, field, reason` |
| `PARSE_ERROR` | File watcher | `ts, op, project, card_id, reason` |
| `RECONCILED` | Startup | `ts, op, project, card_id, version` |
| `ORPHAN_REMOVED` | Startup | `ts, op, project, card_id` |
| `SQLITE_REBUILT` | Startup | `ts, op, card_count` |
| `EXTERNAL_MUTATION` | File watcher | `ts, op, project, card_id` |

**Definition of Done:**
- Toda mutação produz entrada com `op`, `actor` e `version` corretos
- Arquivo append-only, nunca sobrescrito
- Nenhuma entrada contém token raw ou body de card
- `EXTERNAL_MUTATION` logado em até 200ms após escrita externa
- Operações `CREATE`, `UPDATE`, `MOVE`, `REORDER` incluem `input_tokens`, `output_tokens` e `model` na entrada do log
- Cada operação mutante bem-sucedida escreve uma linha em `token_log` no SQLite
- Retries idempotentes (mesmo `request_id`) não escrevem em `token_log`

**Testes:**
- Criar card → log `CREATE` com actor, version e campos de token corretos; linha em `token_log` com os mesmos valores
- Edição humana → log `HUMAN_EDIT` (sem campos de token — não é operação MCP); nenhuma linha em `token_log`
- Revert de campo imutável → log `FIELD_REVERTED` com `field` e `reason`
- Restart com SQLite deletado → log `SQLITE_REBUILT` com `card_count` correto
- Inspecionar log → ausência de tokens raw e body de cards
- Verificar que entradas de watcher e startup não contêm campos de token
- Retry com mesmo `request_id` → nenhuma linha nova em `token_log`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-16b: Implementar SSE endpoint server-side (`GET /events`)

**Tipo:** `implementation`

**Descrição:**
Endpoint HTTP que mantém conexões SSE abertas e empurra eventos em tempo real para o plugin. Emitido por `SSEEventBus` (via `CardService`) após cada mutação bem-sucedida. Pré-requisito para TASK-23 da Sprint 03.

**Especificação (§6.10):**

| Event type | Emitido quando |
|---|---|
| `CARD_CREATED` | `kanban_create_card` completa |
| `CARD_UPDATED` | `kanban_update_card` completa |
| `CARD_MOVED` | `kanban_move_card` completa |
| `CARD_REORDERED` | `kanban_reorder_card` completa |
| `CARD_HUMAN_EDITED` | file watcher finaliza reconciliação de edição humana |
| `CARD_DELETED` | file watcher detecta deleção de `.md` por manager |

**Formato de evento:**
```
event: CARD_MOVED
data: {"card_id":"card-abc123","project":"projeto-x","from_status":"todo","to_status":"doing","new_position":3000}

```

**Regras:**
- Endpoint restrito a localhost (não requer token de agente)
- Múltiplos clientes SSE suportados simultaneamente
- Reconexão: implementar `Last-Event-ID` para replay dos últimos 100 eventos
- Eventos emitidos apenas após escrita e SQLite completos — nunca em falhas ou replays idempotentes

**Definition of Done:**
- `GET /events` retorna `Content-Type: text/event-stream`
- Os 6 tipos de evento emitidos com payload correto conforme §6.10 e `docs/design/interfaces.ts`
- Múltiplos clientes conectados recebem o mesmo evento
- Cliente desconectado removido do `SSEEventBus` sem leak
- Eventos não emitidos em retries idempotentes (mesmo `request_id`)

**Testes:**
- Conectar 2 clientes → criar card → ambos recebem `CARD_CREATED`
- Derrubar um cliente → criar card → nenhum erro no servidor, cliente ativo recebe evento
- Retry com mesmo `request_id` → nenhum evento SSE duplicado emitido
- Edição humana reconciliada pelo watcher → cliente SSE recebe `CARD_HUMAN_EDITED`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:
