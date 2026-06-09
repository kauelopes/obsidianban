# Diagramas de Arquitetura — ObsidianKan

Série A: estrutura estática do sistema — quem existe, como se conecta, quais permissões cada ator tem.

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
    Rel(mcp, claudeapi, "—")
    BiRel(mcp, claudeapi, "—")
```

> **Nota:** o workflow e o CLI são processos separados que se comunicam com o MCP Server — detalhados em A2.

---

## A2 — Mapa de Componentes (C4 Container)

Todos os processos e artefatos, com protocolos de comunicação.

```mermaid
flowchart TB
    subgraph internet["☁️ Internet"]
        CLAUDE_API["api.anthropic.com\n(Claude API)"]
    end

    subgraph host["🖥️ Host"]
        subgraph container["📦 Container / Processo MCP"]
            SRV["🗄️ MCP Server\nsrc/ — bind 127.0.0.1:9375\nSingle writer"]
            DB[("SQLite\n(índice + métricas)")]
            SRV --- DB
        end

        WF["⚙️ sprint-workflow.ts\nOrquestrador da sprint\n(processo Node independente)"]
        CLI["🤖 Claude CLI (harness)\nDev agent — spawned por rodada\n(processo filho do workflow)"]
        VAULT[["📂 Vault .md\n(cards, colunas, projetos)"]]
        REPO[["📁 TARGET_REPO\n(código trabalhado pelo dev)"]]
    end

    subgraph client["👤 Cliente"]
        OBS["Obsidian Plugin\nBoard visual + SSE"]
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

---

## A3 — Modelo de Tokens e Autorização

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
    TP -->|"❌ 403"| DEV_TOOLS

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
