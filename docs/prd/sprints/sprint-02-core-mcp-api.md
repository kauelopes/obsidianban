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
- Retry com mesmo `request_id` → resposta idêntica, apenas 1 arquivo criado
- Audit log: entrada `CREATE`

**Testes:**
- Criar card mínimo (só `title`) → defaults corretos (`version=1`, `priority=medium`)
- `status` de coluna inexistente → 400
- `id` no payload → 400 com `disallowed_fields: ["id"]`
- Retry com mesmo `request_id` → mesmo card, sem duplicata no filesystem

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
- Agent: `title, status, priority, tags, due_date, assigned_to, agent_notes, body`
- Manager: acima + `owner`

**Definition of Done:**
- Campo proibido no payload → 400 com `disallowed_fields` (verificado antes do version check)
- `version` incorreta sem campos proibidos → 409 com `current_card` e `conflicting_fields`
- Semântica Replace: sem append automático em nenhum campo
- Audit log: entrada `UPDATE` com `changed_fields`

**Testes:**
- Agente envia `owner` → 400 `disallowed_fields: ["owner"]`
- `version` correta + campos válidos → versão+1, log `UPDATE`
- `version` desatualizada → 409 com `current_card`
- `version` correta + `owner` no payload → 400 (campos proibidos têm prioridade)
- Retry com mesmo `request_id` → mesma resposta, version não incrementa novamente

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
| `request_id` | string, opcional | UUID v4 |

**Definition of Done:**
- `to_status` inexistente em `_meta.json` → 400
- `version` desatualizada → 409
- Card movido aparece no **final** da coluna destino
- Flag `MCP-originated` suprime reprocessamento pelo file watcher
- Audit log: entrada `MOVE` com `from_status`, `to_status`

**Testes:**
- Mover com version correta → status atualizado, `position = MAX+1000`, version+1, log `MOVE`
- Mover com version stale → 409 com `current_card`
- Mover para coluna inexistente → 400

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
| `request_id` | string, opcional | UUID v4 |

**Normalização:** após o reorder, todos os cards da coluna recebem `position = 1000, 2000, 3000, ...` na ordem atual.

**Definition of Done:**
- `after_card_id` de card em outra coluna → 400
- Após reorder, todos os positions são múltiplos de 1000
- Todos os cards afetados têm version incrementada e aparecem em `affected_cards`

**Testes:**
- Reordenar entre 5 cards → positions resultantes `1000, 2000, 3000, 4000, 5000`
- `after_card_id: null` → card vai para o topo (position 1000 após normalização)
- `after_card_id` de outro projeto/coluna → 400
- Todos os afetados em `affected_cards` com version correta

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
| `CREATE` | MCP agent | `ts, op, actor, project, card_id, version` |
| `UPDATE` | MCP agent | `ts, op, actor, project, card_id, version, changed_fields` |
| `MOVE` | MCP agent/plugin | `ts, op, actor, project, card_id, version, from_status, to_status` |
| `REORDER` | MCP agent/plugin | `ts, op, actor, project, card_id, version, affected_cards` |
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

**Testes:**
- Criar card → log `CREATE` com actor e version corretos
- Edição humana → log `HUMAN_EDIT`
- Revert de campo imutável → log `FIELD_REVERTED` com `field` e `reason`
- Restart com SQLite deletado → log `SQLITE_REBUILT` com `card_count` correto
- Inspecionar log → ausência de tokens raw e body de cards

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:
