# ObsidianKan — Visão Geral

ObsidianKan é um servidor MCP (Model Context Protocol) que transforma um vault do Obsidian em um kanban board colaborativo, acessível tanto por humanos quanto por agentes de IA.

---

## O que ele faz

O servidor expõe um conjunto de ferramentas MCP que permitem criar, mover e acompanhar cards de trabalho — armazenados como arquivos `.md` dentro do vault. Tudo que um agente escreve aparece imediatamente no Obsidian; tudo que um humano edita no Obsidian é reconciliado automaticamente pelo servidor.

```
Agentes de IA ──► MCP Server ──► arquivos .md no Obsidian vault
                      │
                  SQLite index (cache)
                      │
                  Plugin Obsidian (board visual + SSE)
```

---

## Componentes principais

### MCP Server
Processo Node.js que expõe 27 tools via dois transportes:

- **stdio** — para agentes locais (Claude Desktop, Claude Code). O cliente spawna o processo MCP como filho.
- **HTTP + SSE** — para agentes remotos ou stacks polyglot. Bind em `127.0.0.1:9375` por padrão.

### Vault
Diretório do Obsidian onde os dados vivem:

```
vault/
  kanban-data/
    <project>/
      <card-slug>.md      # um arquivo por card
      _meta.json          # colunas, sprints e hashes de token do projeto
  .kanban/
    db.sqlite             # índice derivado (rebuildável)
    audit.ndjson          # log imutável de todas as mutações
    manager-tokens.json   # tokens de manager (hash SHA-256)
  _kanban-secrets/
    <project>.md          # token raw exibido uma única vez ao criar o projeto
```

### Plugin Obsidian
Interface visual de board. Consome as tools via HTTP e recebe eventos em tempo real via SSE (`/events`). Não escreve arquivos diretamente — todas as mutações passam pelo MCP.

---

## Cards

Cada card é um arquivo Markdown com frontmatter YAML gerenciado pelo servidor:

```markdown
---
id: card-a1b2c3d4
project: marketing
type: feature
status: in_progress
priority: high
assigned_to: agent:claude-dev
sprint_id: sprint-x9y8z7w6
version: 5
created_at: 2026-05-10T14:00:00Z
---

Corpo do card — editável livremente pelo humano ou pelo agente.

# Agent Log
- **2026-05-12T09:00:00Z** — iniciado o trabalho na tela de login.
- **2026-05-12T11:30:00Z** — bloqueado: falta o endpoint de autenticação. Movendo para review.
```

Campos imutáveis (`id`, `project`, `type`, `version`, `created_at`) são revertidos automaticamente se um humano os alterar no editor.

---

## Sprints

Todo card pertence a um sprint. O ciclo é unidirecional:

```
planning → active → closed
```

Só pode haver um sprint `active` por projeto ao mesmo tempo. Cards no status `done` são arquivados automaticamente ao fechar o sprint. Cards não concluídos podem ser movidos para um sprint de planejamento via `rollover_to`.

---

## Papéis e permissões

Existem três níveis de acesso, controlados pelo tipo de token:

| | Dev Agent | PM Agent | Manager |
|---|---|---|---|
| Ler e buscar cards | ✅ | ✅ | ✅ |
| Logar progresso no card | ✅ | ✅ | ✅ |
| Mover card entre colunas | ✅ | ✅ | ✅ |
| Claim / release de card | ✅ | ✅ | ✅ |
| Criar cards | ❌ | ✅ | ✅ |
| Atualizar campos do card | ❌ | ✅ | ✅ |
| Gerenciar sprints | ❌ | ✅ | ✅ |
| Arquivar / deletar cards | ❌ | ✅ | ✅ |
| Criar projetos e tokens | ❌ | ❌ | ✅ |

### Protocolo de comunicação do Dev Agent

Dev agents não criam cards. Quando estão bloqueados ou querem propor algo:

1. **`kanban_log_on_card`** — documenta o problema ou proposta no card.
2. **`kanban_move_card { to_status: "review" }`** — entrega o card para o PM.
3. **`kanban_pick_next`** — segue para o próximo trabalho disponível.

O PM agent lê os cards em `review` e decide: fechar, criar um novo card, ou resolver o bloqueio e devolver ao `todo`.

---

## Fluxo típico de trabalho

```
Manager
  └─► cria projeto (kanban_create_project)
  └─► emite tokens PM e Dev (kanban_create_agent_token)
  └─► cria sprint (kanban_create_sprint)

PM Agent
  └─► cria cards no backlog (kanban_create_card / kanban_bulk_create_cards)
  └─► inicia sprint (kanban_start_sprint → cards vão para todo)

Dev Agent
  └─► pega próximo card (kanban_pick_next)
  └─► reivindica o card (kanban_claim_card)
  └─► executa → loga progresso (kanban_log_on_card)
  └─► move para done (kanban_move_card)
       OU
  └─► está bloqueado → loga + move para review (kanban_log_on_card + kanban_move_card)

PM Agent
  └─► lê cards em review, decide e age
  └─► fecha sprint (kanban_close_sprint)
```

---

## Garantias de consistência

- **Escrita atômica** — toda mutação usa `.tmp → rename`. Nunca há arquivo parcialmente escrito.
- **Versão otimista** — cada call mutante exige o `version` atual. Conflito retorna 409 com o estado atual do card.
- **Idempotência** — toda call aceita `request_id` (UUID v4). Retry com o mesmo id retorna a resposta cacheada sem re-executar.
- **SQLite como cache** — o índice é sempre rebuildável a partir dos `.md`. Na inicialização, o servidor reconcilia divergências por SHA-256.
- **Audit log** — toda mutação (MCP ou edição humana) é registrada em `audit.ndjson` com operação, ator, versão e tokens consumidos.

---

## Documentos de referência

| Documento                   | Conteúdo                                                    |
| --------------------------- | ----------------------------------------------------------- |
| `docs/agent-runbook.md`     | Como emitir tokens, configurar clientes, operar o servidor  |
| `docs/integration-guide.md` | Protocolo wire completo: auth, idempotência, conflitos, SSE |
| `docs/design/mcp-server.md` | Diagrama de classes e invariantes de design                 |
| `docs/prd/sections/`        | PRD completo: modelo de dados, regras de negócio, workflows |
| `docs/architecture/`        | Relatórios de sprint com decisões de arquitetura            |

