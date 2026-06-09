# Fluxos de Processo — ObsidianKan

Série B: como usar o sistema — os três fluxos principais do ciclo de vida de uma sprint.

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

    REVIEW_SCOPE{"backlog\nbalanceado?"}
    ADJUST["ajusta escopo:\nremove / divide cards\nprioriza por dependência"]
    REVIEW_SCOPE -->|não| ADJUST --> REVIEW_SCOPE

    ADD_SPRINT["kanban_add_to_sprint\n(adiciona cards selecionados)"]
    REVIEW_SCOPE -->|sim| ADD_SPRINT

    CONFIRM{"sprint\npronta?"}
    ADD_SPRINT --> CONFIRM
    CONFIRM -->|não| ADJUST

    START_CMD["kanban_start_sprint"]
    CONFIRM -->|sim| START_CMD

    WORKFLOW(["WorkflowRunner auto-lança\nse WORKFLOW_ENABLED=true\n→ ver Fluxo B2"])
    START_CMD --> WORKFLOW

    classDef terminal fill:#e6f4ea,stroke:#34a853,stroke-width:2px
    classDef action fill:#e8f0fe,stroke:#4285f4
    class START,WORKFLOW terminal
```

---

## B2 — Execução da Sprint

O que acontece durante a sprint — visão do processo completo de uma rodada.

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
        WF->>WF: triagem híbrida (ver B3 detalhe)
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
        note over WF: volta ao início da próxima rodada
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

O que acontece quando o loop drena — do último card ao fechamento.

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

    NEXT(["Próxima sprint:\nvolta ao Fluxo B1"])
    ARCHIVE --> NEXT

    classDef terminal fill:#e6f4ea,stroke:#34a853,stroke-width:2px
    classDef action fill:#e8f0fe,stroke:#4285f4
    class DRAIN,NEXT terminal
```
