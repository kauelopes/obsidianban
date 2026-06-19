# Arquitetura — ObsidianKan

Referência técnica da arquitetura do sistema: estrutura estática, fluxos de processo e padrões de implementação.

---

## Índice

- [A1 — Contexto do Sistema](#a1--contexto-do-sistema-c4-context)
- [A2 — Mapa de Componentes](#a2--mapa-de-componentes)
- [A3 — Modelo de Tokens e Autorização (RBAC)](#a3--modelo-de-tokens-e-autorização-rbac)
- [A4 — Setup Inicial de Agentes](#a4--setup-inicial-de-agentes-sequência)
- [A5 — Loop Interno do Sprint Workflow](#a5--loop-interno-do-sprint-workflow)
- [B1 — Criação de Sprint](#b1--criação-de-sprint)
- [B2 — Execução da Sprint](#b2--execução-da-sprint)
- [B3 — Ciclo de Vida de um Card](#b3--ciclo-de-vida-de-um-card)
- [B4 — Encerramento de Sprint](#b4--encerramento-de-sprint)
- [Padrões Arquiteturais](#padrões-arquiteturais)

---

## A1 — Contexto do Sistema (C4 Context)

Visão mais alta: os atores externos e o sistema como caixa-preta.

```mermaid
C4Context
    title ObsidianKan — Contexto do Sistema

    Person(user, "Usuário", "Gerencia projetos e sprints pelo Obsidian ou pelo Claude CLI")

    System_Boundary(obsidiankan, "ObsidianKan") {
        System(mcp, "MCP Server", "Servidor HTTP que gerencia o estado do kanban")
    }

    System_Ext(obsidian, "Obsidian", "App de notas — exibe o board via plugin")
    System_Ext(claudeapi, "Claude API (Anthropic)", "LLM usado pelo workflow e pelo dev harness")
    System_Ext(vault, "Vault (filesystem)", "Arquivos .md que representam cards e colunas")
    System_Ext(repo, "Repositório de Código", "Repo trabalhado pelo dev agent")

    Rel(user, obsidian, "Visualiza e gerencia board")
    Rel(user, mcp, "Setup: cria projetos, sprints, tokens via CLI")
    Rel(obsidian, mcp, "HTTP: lê estado do board, recebe SSE")
    Rel(mcp, vault, "Lê e escreve arquivos .md")
    BiRel(mcp, claudeapi, "—")
```

---

## A2 — Mapa de Componentes

Todos os processos e artefatos, com protocolos de comunicação.

```mermaid
flowchart TB
    subgraph internet["☁️ Internet"]
        CLAUDE_API["api.anthropic.com\n(Claude API)"]
    end

    subgraph host["🖥️ Host"]
        subgraph process_mcp["⚙️ Processo MCP"]
            SRV["🗄️ MCP Server\npackages/server — bind 127.0.0.1:9375\nSingle writer"]
            DB[("SQLite\n(índice + métricas)")]
            SRV --- DB
        end

        WF["⚙️ sprint-workflow.ts\nOrquestrador da sprint\n(processo Node independente)"]
        CLI["🤖 Claude CLI (harness)\nDev agent — spawned por rodada\n(processo filho do workflow)"]
        VAULT[["📂 Vault .md\n(cards, colunas, projetos)"]]
        REPO[["📁 TARGET_REPO\n(código trabalhado pelo dev)"]]
    end

    subgraph client["👤 Cliente"]
        OBS["Obsidian Plugin\n(packages/plugin)\nBoard visual + SSE"]
        USER["Usuário\n(CLI: manager / pm / dev)"]
    end

    USER -->|"HTTP POST /mcp/tool\nBearer manager-token"| SRV
    OBS -->|"HTTP /mcp\nSSE /sse"| SRV
    WF -->|"HTTP POST /mcp/tool\nBearer pm-token"| SRV
    WF -->|"HTTPS — SDK direto\n(triage LLM)"| CLAUDE_API
    WF -->|"spawn('claude', args)"| CLI
    CLI -->|"HTTP POST /mcp/tool\nBearer dev-token"| SRV
    CLI -->|"HTTPS\n(dev harness)"| CLAUDE_API
    CLI -->|"file/bash tools"| REPO
    SRV -->|"lê/escreve"| VAULT

    classDef srv fill:#fef7e0,stroke:#f9ab00,stroke-width:2px
    classDef wf fill:#e8f0fe,stroke:#4285f4,stroke-width:2px
    classDef cli fill:#e6f4ea,stroke:#34a853,stroke-width:2px
    classDef ext fill:#f1f3f4,stroke:#9aa0a6,stroke-width:1px,stroke-dasharray:4 4
    class SRV srv
    class WF wf
    class CLI cli
    class VAULT,REPO,DB ext
```

**Estrutura do monorepo:**
- `packages/server/` — MCP Server (Node.js, TypeScript, better-sqlite3)
- `packages/plugin/` — Plugin Obsidian (esbuild, DOM)
- `packages/shared/` — Tipos compartilhados (`@obsidiankan/types`)

---

## A3 — Modelo de Tokens e Autorização (RBAC)

Três tipos de token, cada um com escopo imutável imposto server-side.

```mermaid
flowchart LR
    subgraph tokens["Tokens (mintados pelo manager)"]
        TM["🔑 Manager Token\nagent_type = manager"]
        TP["🔑 PM Token\nagent_type = pm"]
        TD["🔑 Dev Token\nagent_type = dev"]
    end

    subgraph tools["Ferramentas MCP"]
        ADMIN["kanban_create_project\nkanban_create_agent_token\nkanban_delete_project\n..."]
        PM_TOOLS["kanban_create_card\nkanban_create_sprint\nkanban_start_sprint\nkanban_move_card\nkanban_log_on_card\n..."]
        DEV_TOOLS["kanban_pick_next\nkanban_claim_card\nkanban_get_card\nkanban_list_cards\n..."]
        SHARED["kanban_list_projects\nkanban_get_sprint\nkanban_list_sprints\n..."]
    end

    TM -->|"acesso total"| ADMIN
    TM -->|"acesso total"| PM_TOOLS
    TM -->|"acesso total"| DEV_TOOLS
    TM -->|"acesso total"| SHARED

    TP -->|"✅"| PM_TOOLS
    TP -->|"✅"| SHARED
    TP -->|"❌ 403"| ADMIN

    TD -->|"✅"| DEV_TOOLS
    TD -->|"✅"| SHARED
    TD -->|"❌ 403"| ADMIN
    TD -->|"❌ 403"| PM_TOOLS

    classDef manager fill:#fce8e6,stroke:#d93025
    classDef pm fill:#e8f0fe,stroke:#4285f4
    classDef dev fill:#e6f4ea,stroke:#34a853
    class TM manager
    class TP pm
    class TD dev
```

> O token é injetado **no host** (env var). O modelo nunca o vê — a autorização é transparente para o LLM.

---

## A4 — Setup Inicial de Agentes (Sequência)

O que o usuário faz uma vez antes de usar o sistema.

```mermaid
sequenceDiagram
    actor U as Usuário
    participant CLI as Claude CLI
    participant SRV as MCP Server
    participant ENV as .env / ambiente

    U->>CLI: claude (com manager token)
    note over CLI: carrega skill kanban-manager-agent

    CLI->>SRV: kanban_create_project(name, description)
    SRV-->>CLI: { project_id }

    CLI->>SRV: kanban_create_agent_token(type=pm, project_id)
    SRV-->>CLI: { token: "pm-..." }
    CLI->>ENV: salva KANBAN_PM_TOKEN

    CLI->>SRV: kanban_create_agent_token(type=dev, project_id)
    SRV-->>CLI: { token: "dev-..." }
    CLI->>ENV: salva KANBAN_DEV_TOKEN

    note over U,ENV: tokens salvos no .env — setup concluído

    U->>ENV: WORKFLOW_ENABLED=true\nANTHROPIC_API_KEY=sk-ant-...
    note over U: reinicia o servidor para aplicar
```

---

## A5 — Loop Interno do Sprint Workflow

O que acontece automaticamente após `kanban_start_sprint`.

```mermaid
flowchart TD
    START(["kanban_start_sprint chamado"])
    LAUNCH["WorkflowRunner.launch(sprint_id)\n(processo filho detached)"]
    HEALTH{"MCP Server\nacessível?"}
    FAIL1["exit 1: servidor offline"]
    ACTIVE{"sprint\nativa?"}
    FAIL2["exit 1: nenhuma sprint ativa"]

    ROUND["Inicia rodada N"]
    LIMIT{"N > MAX_ROUNDS\n(default 50)?"}
    ABORT["exit: limite de rodadas atingido"]

    REVIEW{"há cards\nem review?"}
    TRIAGE["Triagem híbrida da review\n(ver detalhe abaixo)"]

    READY{"há cards\nem todo?"}
    DRAINED(["Sprint drenada — fim ✅"])

    DEV["Spawna Claude CLI (dev harness)\nDEV_DRAIN_LIMIT cards por spawn"]
    COST["loga custo da rodada\nacumula em sprintTotals"]

    START --> LAUNCH --> HEALTH
    HEALTH -->|não| FAIL1
    HEALTH -->|sim| ACTIVE
    ACTIVE -->|não| FAIL2
    ACTIVE -->|sim| ROUND
    ROUND --> LIMIT
    LIMIT -->|sim| ABORT
    LIMIT -->|não| REVIEW
    REVIEW -->|sim| TRIAGE --> READY
    REVIEW -->|não| READY
    READY -->|não| DRAINED
    READY -->|sim| DEV --> COST --> ROUND

    subgraph triage["Triagem da review (híbrida)"]
        T1["Para cada card em review"]
        T2{"blockers\ntodos done?"}
        T3["código: move → todo\n(anti-loop counter)"]
        T4{"ambíguo?"}
        T5["LLM (pm token) decide:\nCLOSE / RETURN / FOLLOW-UP"]
        T6["CLOSE → move done\nRETURN → update + move todo\nFOLLOW-UP → cria card filho\n+ resolve original"]
        T1 --> T2
        T2 -->|sim| T3
        T2 -->|não| T4
        T4 -->|não| T3
        T4 -->|sim| T5 --> T6
    end

    classDef terminal fill:#e6f4ea,stroke:#34a853,stroke-width:2px
    classDef error fill:#fce8e6,stroke:#d93025,stroke-width:2px
    classDef decision fill:#fef7e0,stroke:#f9ab00
    class DRAINED terminal
    class FAIL1,FAIL2,ABORT error
```

---

## B1 — Criação de Sprint

Do backlog vazio à sprint pronta para iniciar.

```mermaid
flowchart TD
    START(["PM inicia sessão\n(Claude CLI com pm-token)"])

    PROJ{"projeto\nexiste?"}
    CREATE_PROJ["kanban_create_project\n+ kanban_create_agent_token ×2"]
    PROJ -->|não| CREATE_PROJ --> SPRINT_NAME
    PROJ -->|sim| SPRINT_NAME

    SPRINT_NAME["Define nome e goal da sprint"]
    CREATE_SPRINT["kanban_create_sprint(name, goal)"]
    SPRINT_NAME --> CREATE_SPRINT

    CARDS["Cria cards no backlog\nkanban_create_card\n(title, description, acceptance_criteria)"]
    CREATE_SPRINT --> CARDS

    subgraph card_loop["Para cada card"]
        DEP{"tem\ndependência?"}
        ADD_DEP["kanban_update_card\n(blocked_by: [card_id])"]
        DEP -->|sim| ADD_DEP
        DEP -->|não| NEXT_CARD["próximo card"]
        ADD_DEP --> NEXT_CARD
    end

    CARDS --> card_loop

    ADD_SPRINT["kanban_add_to_sprint\n(adiciona cards selecionados)"]
    card_loop --> ADD_SPRINT

    START_CMD["kanban_start_sprint"]
    ADD_SPRINT --> START_CMD

    WORKFLOW(["WorkflowRunner auto-lança\nse WORKFLOW_ENABLED=true\n→ ver A5"])
    START_CMD --> WORKFLOW

    classDef terminal fill:#e6f4ea,stroke:#34a853,stroke-width:2px
    class START,WORKFLOW terminal
```

---

## B2 — Execução da Sprint

O que acontece durante a sprint — visão completa de uma rodada.

```mermaid
sequenceDiagram
    participant WF as sprint-workflow.ts
    participant SRV as MCP Server
    participant DEV as Claude CLI (dev)
    participant REPO as Repositório
    participant API as Claude API

    note over WF: rodada N começa

    WF->>SRV: list_cards(status=review) [pm-token]
    SRV-->>WF: cards em review

    alt há cards em review
        WF->>WF: triagem híbrida (ver A5)
        WF->>SRV: move_card / update_card / create_card [pm-token]
    end

    WF->>SRV: list_cards(status=todo) [pm-token]
    SRV-->>WF: cards prontos

    alt nenhum card pronto
        WF-->>WF: sprint drenada — encerra loop
    else há cards prontos
        WF->>DEV: spawn('claude', [--print, prompt, --mcp-config dev.mcp.json])

        loop até DEV_DRAIN_LIMIT cards ou pick_next vazio
            DEV->>SRV: kanban_pick_next [dev-token]
            SRV-->>DEV: próximo card disponível

            DEV->>SRV: kanban_claim_card(card_id) [dev-token]
            SRV-->>DEV: card movido → in_progress

            DEV->>SRV: kanban_get_card(card_id) [dev-token]
            SRV-->>DEV: descrição, acceptance criteria, blocked_by

            DEV->>API: mensagens Claude (implementação)
            API-->>DEV: resposta + tool calls

            DEV->>REPO: edita arquivos, roda testes (bash/file tools)

            alt implementação concluída
                DEV->>SRV: kanban_move_card(done) [dev-token]
            else blocker encontrado
                DEV->>SRV: kanban_update_card(blocked_reason) [dev-token]
                DEV->>SRV: kanban_move_card(review) [dev-token]
            end

            DEV->>SRV: kanban_log_on_card(resumo + custo) [dev-token]
        end

        DEV-->>WF: resultado JSON (custo, cards trabalhados)
        WF->>WF: loga custo da rodada
        note over WF: próxima rodada
    end
```

---

## B3 — Ciclo de Vida de um Card

Os estados pelos quais um card passa e quem pode executar cada transição.

```mermaid
stateDiagram-v2
    [*] --> backlog : kanban_create_card\n(PM / Manager)

    backlog --> todo : kanban_add_to_sprint\n+ kanban_start_sprint\n(PM)

    todo --> in_progress : kanban_claim_card\n(Dev — pick_next)

    in_progress --> review : kanban_move_card\nblocker encontrado\n(Dev)

    in_progress --> done : kanban_move_card\nimplementação ok\n(Dev)

    review --> todo : triagem: blocker resolvido\nou LLM decide RETURN\n(Workflow / PM)

    review --> done : triagem: LLM decide CLOSE\n(Workflow / PM)

    review --> review : triagem: LLM decide FOLLOW-UP\n(cria card filho, resolve original)

    done --> [*]

    note right of in_progress
        Dev loga progresso via
        kanban_log_on_card
        durante a execução
    end note

    note right of review
        Anti-loop counter impede
        que um card quique
        review → todo indefinidamente
    end note
```

---

## B4 — Encerramento de Sprint

```mermaid
flowchart TD
    DRAIN(["sprint drenada\n(todo vazio + review vazia)"])

    SUMMARY["Workflow imprime resumo:\n• rodadas executadas\n• cards done / review / bloqueados\n• custo total (tokens + $)"]

    REVIEW_REMAINING{"ainda há cards\nem review?"}
    DRAIN --> SUMMARY --> REVIEW_REMAINING

    MANUAL_TRIAGE["PM revisa manualmente\nObsidian board ou CLI"]
    REVIEW_REMAINING -->|sim| MANUAL_TRIAGE

    CLOSE_SPRINT["kanban_close_sprint\n(PM / Manager)"]
    REVIEW_REMAINING -->|não| CLOSE_SPRINT
    MANUAL_TRIAGE --> CLOSE_SPRINT

    subgraph close["Ao fechar a sprint"]
        METRICS["métricas registradas no SQLite\n(velocity, completion rate, custo)"]
        LEFTOVER{"cards não concluídos\n(blocked / todo)?"}
        BACKLOG_RETURN["kanban_move_card → backlog\nprioridade para próxima sprint"]
        ARCHIVE["sprint arquivada\n(histórico preservado)"]
        METRICS --> LEFTOVER
        LEFTOVER -->|sim| BACKLOG_RETURN --> ARCHIVE
        LEFTOVER -->|não| ARCHIVE
    end

    CLOSE_SPRINT --> close

    NEXT(["Próxima sprint:\nvolta ao B1"])
    ARCHIVE --> NEXT

    classDef terminal fill:#e6f4ea,stroke:#34a853,stroke-width:2px
    class DRAIN,NEXT terminal
```

---

## Padrões Arquiteturais

### Optimistic Locking
Todo card tem um campo `version` (inteiro). Escritas concorrentes que chegam com `version` desatualizado recebem `409 Conflict` com o estado atual e os campos conflitantes. O cliente deve releer e decidir como resolver.

### Idempotência
Operações de mutação aceitam `request_id` opcional. Requisições repetidas com o mesmo `request_id` retornam a resposta original sem efeitos colaterais. O store de idempotência fica em `.kanban/idempotency.json`.

### Markdown como fonte de verdade
Cards são arquivos `.md` em `vault/kanban-data/<project>/`. O SQLite é um índice derivado, reconstruído automaticamente no startup a partir dos `.md` se estiver ausente ou desatualizado. Edições manuais no vault são detectadas pelo file watcher (chokidar) e reconciliadas.

### Escritas atômicas
Todas as escritas em disco usam arquivos `.tmp` renomeados atomicamente, prevenindo corrupção em caso de crash ou escritas simultâneas de agentes e humanos.

### Broadcast SSE
O servidor mantém um bus SSE central. Mutações em cards, projetos e sprints disparam eventos para todos os clientes conectados (plugin Obsidian). 14 tipos de evento: `CARD_*`, `PROJECT_*`, `SPRINT_*`.

### Audit trail
Toda operação é gravada em `audit.ndjson` com timestamp, ator, tipo de operação e campos afetados. O log é append-only e imutável.

### Single writer
O processo MCP é o único escritor do vault e do SQLite. Agentes PM e Dev interagem exclusivamente via HTTP/MCP, nunca acessam o filesystem diretamente.
