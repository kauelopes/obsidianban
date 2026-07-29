# Sprint Workflow — Execução Orquestrada por Código

`scripts/sprint-workflow.ts` executa uma sprint inteira de forma autônoma, dirigindo
os mesmos tools `kanban_*` que o board já usa, mas trocando o **PM prompted + CLI manual**
por um **workflow**: o loop, o sequenciamento e a condição de parada são código
determinístico; o LLM só é chamado onde há julgamento real.

> **Workflow vs. Agente** (no sentido do *Building Effective Agents* da Anthropic):
> um **workflow** é um caminho de código pré-definido orquestrando chamadas ao LLM;
> um **agente** deixa o LLM dirigir a própria trajetória. Na fase de sprint, as decisões
> do PM ("ainda há card pronto? → chama dev"; "review vazia? → fim") são condicionais
> sobre o estado do board — `if/else`, não julgamento. Então viram código.

---

## Onde o processo roda

O workflow **não roda no Obsidian** nem **dentro do servidor**. É um **terceiro processo
Node independente** que você lança. Ele não toca o banco diretamente — passa pelos tools
HTTP do servidor, igual a todo mundo. O servidor continua sendo o **único dono** do
SQLite + vault (single writer).

```mermaid
flowchart TB
    subgraph cloud["☁️ Internet"]
        ANTHROPIC["api.anthropic.com<br/>(Claude API — triagem PM)"]
    end

    subgraph host["🖥️ Mesma máquina (host)"]
        WF["⚙️ sprint-workflow.ts<br/>processo Node que VOCÊ lança<br/>(orquestração + triagem via API)"]
        CLI["🤖 claude CLI (harness)<br/>spawned por round<br/>(execução dev)"]
        SRV["🗄️ Kanban MCP Server (src/)<br/>bind 127.0.0.1:9375<br/>single writer"]
        DB[("SQLite index")]
        VAULT[["Vault .md<br/>(Obsidian)"]]
        REPO[["📁 TARGET_REPO<br/>(repo trabalhado pelo dev)"]]
    end

    subgraph user["👤 Cliente humano"]
        WEB["Web app (packages/web)<br/>mesma origem — board visual + SSE"]
    end

    WF -->|"HTTPS<br/>(triagem — Anthropic SDK)"| ANTHROPIC
    WF -->|"HTTP POST /mcp/tool/<br/>Bearer pm token"| SRV
    WF -->|"spawn('claude', ...)"| CLI
    CLI -->|"HTTP POST /mcp/tool/<br/>Bearer dev token"| SRV
    CLI -->|"file/bash tools<br/>(contido em TARGET_REPO)"| REPO
    CLI -->|"HTTPS<br/>(execução dev)"| ANTHROPIC
    WEB -->|"fetch /mcp/tool + SSE /events"| SRV
    SRV --- DB
    SRV --> VAULT

    classDef wf fill:#e8f0fe,stroke:#4285f4,stroke-width:2px;
    classDef cli fill:#e6f4ea,stroke:#34a853,stroke-width:2px;
    classDef srv fill:#fef7e0,stroke:#f9ab00,stroke-width:2px;
    class WF wf;
    class CLI cli;
    class SRV srv;
```

Por que **na mesma máquina que o servidor**:

| Motivo | Detalhe |
|---|---|
| Alcance do servidor | `KANBAN_URL` default é `127.0.0.1:9375`; o servidor faz bind só em **loopback** — o workflow precisa estar no mesmo host. |
| Saída para a API | Precisa de internet de saída para `api.anthropic.com`. |
| Acesso ao código | O harness do dev edita arquivos em `TARGET_REPO` no filesystem local. |

O Obsidian nem sabe que o workflow existe — só vê os cards se moverem no board via SSE,
como se um humano ou agente estivesse mexendo.

---

## Os três atores e a fronteira de identidade

Todos falam com o servidor pelo mesmo HTTP, mas com **tokens diferentes**. O servidor
**impõe o escopo por token** (um dev tentando um tool de PM recebe `403`). O workflow
injeta o Bearer correto **host-side** — o modelo nunca vê o token.

```mermaid
flowchart LR
    subgraph WF["sprint-workflow.ts"]
        ORq["Orquestrador<br/>(código puro, pm token)"]
        DEV["Runner DEV<br/>(harness spawn, dev token)"]
        TRI["Triagem LLM<br/>(Anthropic SDK, pm token)"]
    end

    ORq -->|"pm token (HTTP direto)"| S
    DEV -->|"dev token (via MCP config)"| S
    TRI -->|"pm token (betaZodTool)"| S
    S["Servidor valida token<br/>e impõe escopo (403 fora do escopo)"]

    classDef code fill:#e6f4ea,stroke:#34a853;
    class ORq code;
```

- **Orquestrador** — código puro. Lê o board (pm token via HTTP direto) para decidir.
- **Runner DEV** — `child_process.spawn('claude', ...)`. O harness carrega o dev token
  via env var; o modelo nunca o vê.
- **Triagem LLM** — Anthropic SDK com `betaZodTool`. Tools injetadas com pm token
  host-side pelo wrapper `kanbanTool`.

---

## O loop de orquestração

Código determinístico. Cada rodada: triagem da `review` primeiro, depois despacho de um
dev, até a sprint drenar. Há um `MAX_ROUNDS` (default 50) como trava de segurança.

```mermaid
flowchart TD
    START(["start"]) --> HEALTH{"servidor<br/>acessível?"}
    HEALTH -->|não| FAIL1["erro: servidor offline<br/>exit 1"]
    HEALTH -->|sim| SPRINT{"sprint<br/>ativa?"}
    SPRINT -->|não| FAIL2["erro: nenhuma sprint ativa<br/>exit 1"]
    SPRINT -->|sim| ROUND{"round <<br/>MAX_ROUNDS?"}

    ROUND -->|não| STOP["trava: MAX_ROUNDS atingido"]
    ROUND -->|sim| REVIEW{"há cards<br/>em review?"}

    REVIEW -->|sim| TRIAGE["triagem híbrida<br/>(ver diagrama abaixo)"]
    TRIAGE --> ROUND

    REVIEW -->|não| READY{"pick_next<br/>tem card pronto?"}
    READY -->|sim| RUNDEV["runDev(): spawn harness<br/>(até DEV_DRAIN_LIMIT cards)"]
    RUNDEV --> LOG["loga custo da rodada<br/>(agrega ao sprint total)"]
    LOG --> SNAP["para cada card fechado no stream:<br/>logCardTokenSnapshot grava contexto<br/>+ tokens gerados no Agent Log do card"]
    SNAP --> ROUND

    READY -->|não| DRAINED["sprint drenada:<br/>review vazia e todo sem card pronto"]

    STOP --> SUMMARY["imprime resumo da sprint"]
    DRAINED --> SUMMARY
    SUMMARY --> END(["fim"])

    classDef ok fill:#e6f4ea,stroke:#34a853;
    classDef err fill:#fce8e6,stroke:#ea4335;
    class FAIL1,FAIL2 err;
    class DRAINED,SUMMARY ok;
```

A ordem importa: **triar `review` antes de despachar dev** garante que blockers
resolvidos voltem ao `todo` antes do `pick_next` rodar, e evita acumular trabalho
pendente de decisão.

---

## Sequência de uma rodada (caminho feliz)

```mermaid
sequenceDiagram
    autonumber
    participant O as Orquestrador (código)
    participant S as Kanban Server
    participant H as Claude Code harness<br/>(spawn)
    participant A as Claude API
    participant R as TARGET_REPO

    O->>S: list_cards status=review (pm token)
    S-->>O: [] (review vazia)
    O->>S: pick_next (pm token) — probe
    S-->>O: { card: ... } (há trabalho)

    O->>H: spawn('claude', ['-p', prompt, '--mcp-config', ...])
    note over H: harness carrega kanban_* via MCP config<br/>e file/bash tools nativos
    H->>A: agentic loop (dev token injetado via env)
    A->>S: kanban_pick_next → kanban_claim_card → move in_progress
    A->>R: file/bash tools (edições, testes)
    R-->>A: resultado
    A->>S: kanban_log_on_card (resumo)
    A->>S: kanban_move_card → done
    A-->>H: loop encerrado
    H-->>O: stream-json (1 linha/turno) + linha final<br/>{ result, usage, modelUsage, total_cost_usd, num_turns }

    O->>O: parseDevStream: cada tool_use kanban_move_card<br/>(done/review) ou kanban_defer_card vira 1 CardTokenSnapshot
    O->>S: logCardTokenSnapshot por snapshot<br/>(kanban_log_on_card, pm token)
    O->>O: próxima rodada
```

---

## O runner do DEV — `child_process.spawn('claude', ...)`

O dev roda como um **processo `claude` CLI completo**, não como um toolRunner hand-rolled.
Isso é deliberado: o harness traz context management, prompt caching, retry, e as ferramentas
de arquivo/bash maduras — reimplementar tudo isso seria inferior.

```mermaid
flowchart TB
    subgraph WF["runDev() — spawn por rodada"]
        PROMPT["buildDevPrompt(N)<br/>prompt varia com DEV_DRAIN_LIMIT"]
        SPAWN["spawn('claude',<br/>  '-p', prompt,<br/>  '--mcp-config', DEV_MCP_CONFIG,<br/>  '--settings', DEV_SETTINGS,<br/>  '--permission-mode', 'acceptEdits',<br/>  '--output-format', 'stream-json',<br/>  '--verbose',<br/>  '--name', 'kanban-dev',<br/>  cwd=TARGET_REPO,<br/>  env={KANBAN_DEV_TOKEN: ...})"]
        PARSE["parseDevStream: NDJSON linha a linha<br/>→ { result, usage, modelUsage, num_turns, cardSnapshots }"]
    end

    subgraph HARNESS["harness (claude CLI)"]
        MCP["kanban_* tools<br/>(MCP via dev.mcp.json)"]
        FILES["file/bash/glob/grep tools<br/>(nativos do harness)"]
        SKILL["kanban-dev-agent skill<br/>(auto-loaded)"]
    end

    SPAWN -->|"stdio"| HARNESS
    MCP -->|"HTTP /mcp/tool<br/>Bearer dev token"| SRV["Kanban Server"]
    FILES -->|"cwd = TARGET_REPO"| REPO[["📁 TARGET_REPO"]]
    HARNESS --> PARSE

    classDef wf fill:#e8f0fe,stroke:#4285f4;
    classDef h fill:#e6f4ea,stroke:#34a853;
    class SPAWN,PROMPT,PARSE wf;
    class MCP,FILES,SKILL h;
```

**Configurações por path absoluto** — `DEV_MCP_CONFIG` e `DEV_SETTINGS` são resolvidos
a partir de `REPO_ROOT` (diretório do workflow), **não** de `TARGET_REPO`. O `cwd` do
spawn é `TARGET_REPO`, que pode ser um repo diferente; usar paths relativos quebraria
quando eles divergem.

**Prompt parametrico** (`buildDevPrompt`): o texto muda conforme `DEV_DRAIN_LIMIT`:

| N | Instrução principal |
|---|---|
| `1` | "Pick EXACTLY ONE ready card … then STOP. Do not start a second card." |
| `> 1` | "Work up to N ready cards. … STOP when ANY of these is true: completed N; pick_next empty; blocker → review." |

O skill `kanban-dev-agent` (auto-carregado pelo harness) já traz o protocolo completo
(`claim → in_progress → work → log → done/review`); o prompt só acrescenta a granularidade
e a definição de parada.

---

## Medição de custo e contexto por card — `parseDevStream`

O harness roda com `--output-format stream-json --verbose`: em vez de um único JSON no
final, cada turno do agente vira uma linha NDJSON no stdout, e a última linha (`type:
"result"`) é o mesmo payload que `--output-format json` sempre devolveu (`usage`,
`modelUsage`, `total_cost_usd`, `num_turns`). Isso vale **independente de `DEV_DRAIN_LIMIT`**
— não há mais um caminho "exato" só para N=1 e um caminho "agregado" para N>1.

```mermaid
flowchart TD
    STREAM["stdout: 1 linha JSON por turno"] --> LOOP{"para cada linha<br/>'assistant'"}

    LOOP --> USAGE["lastUsage = message.usage<br/>(usage DAQUELE turno — não cumulativo)"]
    USAGE --> ACC["cardOutputTokens += usage.output_tokens"]
    ACC --> TOOL{"content tem<br/>tool_use com<br/>kanban_move_card<br/>(to done/review) ou<br/>kanban_defer_card?"}

    TOOL -->|não| LOOP
    TOOL -->|sim| SNAP["push CardTokenSnapshot:<br/>contexto = lastUsage (input+cache)<br/>cardOutputTokens acumulado<br/>zera cardOutputTokens"]
    SNAP --> LOOP

    LOOP -->|fim do stream| RESULT["linha 'result': usage total,<br/>modelUsage, contextWindow do modelo"]
```

**Dois números com significado diferente, por design:**

- **Tamanho do contexto** (`contextInputTokens + contextCacheReadTokens + contextCacheCreationTokens`
  do último turno antes do fechamento): a API é *stateless* e reenvia o histórico inteiro a
  cada turno — então o `usage` de um turno **é**, por definição, o tamanho da janela de
  contexto naquele ponto. Não é estimativa. Reportado também como `%` de
  `modelUsage[model].contextWindow` quando o harness o expõe.
- **Tokens gerados para o card** (`cardOutputTokens`): soma de `output_tokens` de todos os
  turnos desde o fechamento do card anterior (ou desde o início da rodada, no primeiro
  card). Representa o trabalho atribuível a *este* card especificamente, mesmo quando vários
  cards são resolvidos na mesma sessão (`DEV_DRAIN_LIMIT > 1`).

Cada `CardTokenSnapshot` é gravado no `# Agent Log` do card via `logCardTokenSnapshot`
(`kanban_log_on_card`, pm token) assim que a rodada termina — um snapshot por card que
fechou (`done`/`review`) ou foi deferido, não importa quantos cards a rodada tenha tocado.
O custo agregado da rodada inteira (`total_cost_usd`, `usage` da linha `result`) continua
indo para `sprintTotals` e para o `token_log` via `reportRoundUsage`, como antes — os dois
mecanismos coexistem: um mede a rodada, o outro atribui por card dentro dela.

> **Por que não também um `cost_usd` exato por card?** A API cobra por chamada, e o custo de
> uma chamada mistura tokens novos com tokens de cache reaproveitados do histórico — dividir
> isso "corretamente" entre cards da mesma sessão é uma estimativa, não uma medição. Os dois
> números que gravamos (contexto e tokens gerados) são exatos; `cost_usd` por card ficou de
> fora de propósito para não misturar um número exato com um estimado no mesmo campo.

---

## Triagem híbrida da review

Código trata o caso **mecânico**; o LLM só vê o **ambíguo**. Um contador anti-loop evita
que um card fique quicando `review → todo → review` para sempre.

```mermaid
flowchart TD
    IN(["cards em review"]) --> LOOP{"para cada card"}

    LOOP --> GET["kanban_get_card → version, blocked_by"]
    GET --> CLEARED{"blocked_by != vazio<br/>E todos os blockers<br/>estão done?"}

    CLEARED -->|"sim E ainda<br/>não auto-devolvido"| RETURN["código: log + move → todo<br/>(incrementa contador anti-loop)"]
    CLEARED -->|não| AMBIG["marca como ambíguo"]

    RETURN --> LOOP
    AMBIG --> LOOP

    LOOP -->|fim| HASAMB{"sobrou<br/>ambíguo?"}
    HASAMB -->|não| DONE(["rodada segue"])
    HASAMB -->|sim| LLM["triageReviewLLM (effort: high)<br/>toolRunner → acumula usage por turno<br/>decide:"]

    LLM --> C1["CLOSE → kanban_move_card done"]
    LLM --> C2["RETURN → kanban_update_card + move todo"]
    LLM --> C3["FOLLOW-UP → kanban_create_card<br/>+ resolve o original"]

    classDef code fill:#e6f4ea,stroke:#34a853;
    classDef llm fill:#f3e8fd,stroke:#a142f4;
    class RETURN code;
    class LLM,C1,C2,C3 llm;
```

> A detecção de "trabalho concluído" (CLOSE) é deixada de propósito para o LLM — exige
> ler o log e julgar. O código só faz o que é puramente mecânico: devolver ao `todo` um
> card cujo único obstáculo era um blocker agora `done`.

A triagem LLM itera o `toolRunner` para **somar usage de todos os turnos** (a forma
`await` só expõe o último turno; `for await` acumula tudo). Custo calculado a
`$5/$25` por 1M tokens (Opus 4.8).

---

## Rate limit — créditos esgotados

A Anthropic libera créditos periodicamente. Quando acabam no meio de uma sprint, o
workflow **espera e retenta automaticamente** — não aborta. Os dois caminhos têm
sinais diferentes:

```mermaid
flowchart TD
    subgraph SPAWN["Caminho: spawn do harness (dev)"]
        SR["runClaudeDev() retorna\nis_error=true"]
        SD{"result contém\n'hit your … limit'\nou 'rate limit'?"}
        SW["sleep(RATE_LIMIT_WAIT_SECONDS)\nretenta o spawn do zero"]
        SE["erro real — propaga"]
        SR --> SD
        SD -->|sim| SW
        SD -->|não| SE
        SW -->|"attempt < MAX_RETRIES"| SR
    end

    subgraph SDK["Caminho: toolRunner da triagem (SDK)"]
        TT["toolRunner lança\nRateLimitError (429)"]
        TW["lê headers.get('retry-after')\nou usa RATE_LIMIT_WAIT_SECONDS\nretenta o toolRunner completo"]
        TE["outro erro — relança"]
        TT -->|"attempt < MAX_RETRIES"| TW
        TT -->|"attempt >= MAX_RETRIES\nou erro diferente"| TE
        TW --> TT
    end

    classDef wait fill:#fff3e0,stroke:#f57c00;
    classDef err fill:#fce8e6,stroke:#ea4335;
    class SW,TW wait;
    class SE,TE err;
```

| Caminho | Sinal detectado | Fonte do tempo de espera |
|---|---|---|
| **Spawn** | `is_error=true` + regex no `result`: `"hit your … limit"`, `"rate limit"`, `"credits exhausted"` | `RATE_LIMIT_WAIT_SECONDS` (configurável) |
| **Triage SDK** | `RateLimitError` (HTTP 429) | `retry-after` do header da API; fallback para `RATE_LIMIT_WAIT_SECONDS` |

> **Por que o spawn é retomado do zero?** O harness pode ter progresso parcial quando
> aborta (card em `in_progress`, logs já escritos). Na retentativa, o harness pega o
> estado atual do board via `kanban_pick_next` e continua de onde o card ficou — o
> protocolo do `kanban-dev-agent` skill já prevê isso. Como a atribuição por card agora
> vem do stream da própria tentativa que efetivamente fechou o card (não de um diff de
> board), não há estado externo para refrescar entre tentativas.

Saída no console durante a espera:

```
⏳ DEV: credits exhausted — waiting 5min before retry (attempt 1/10)
⏳ TRIAGE: rate limit (429) — waiting 3min before retry (attempt 1/10)
```

---

## Pré-requisitos e execução

```mermaid
flowchart LR
    A["1. Servidor kanban no ar<br/>(127.0.0.1:9375)"] --> B["2. Sprint ativa<br/>(PM/manager iniciou)"]
    B --> C["3. .env preenchido"]
    C --> D["4. claude CLI no PATH<br/>(Claude Code)"]
    D --> E["5. node --import tsx<br/>scripts/sprint-workflow.ts"]
```

Variáveis de ambiente (`.env`):

| Variável | Obrigatória | Default | Para quê |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | sim | — | Chave da API da Anthropic (triagem LLM). |
| `KANBAN_DEV_TOKEN` | sim | — | Token dev (`agent_type=dev`), mintado pelo manager. Injetado no env do spawn — nunca passado ao modelo. |
| `KANBAN_PM_TOKEN` | sim | — | Token pm (`agent_type=pm`), mintado pelo manager. Usado pelo orquestrador e triagem. |
| `KANBAN_URL` | não | `http://127.0.0.1:9375` | Base do servidor kanban. |
| `TARGET_REPO` | não | `process.cwd()` | Diretório onde o harness do dev opera (`cwd` do spawn). |
| `DEV_DRAIN_LIMIT` | não | `3` | Cards por spawn. `1` = um card/rodada (fecha antes com sessão nova a cada card, sem cache entre cards). `> 1` ≈ drena até N na mesma sessão (cache reaproveitado entre cards). Atribuição de contexto/tokens por card é exata em ambos os casos — ver [Medição de custo e contexto por card](#medição-de-custo-e-contexto-por-card--parsedevstream). |
| `DEV_MCP_CONFIG` | não | `.claude/skills/kanban-pm-agent/dev.mcp.json` | Path absoluto ao MCP config do harness dev. Resolvido a partir do repo do workflow, não de `TARGET_REPO`. |
| `DEV_SETTINGS` | não | `.claude/skills/kanban-pm-agent/dev-settings.json` | Path absoluto ao settings do harness dev. |
| `SPRINT_MAX_ROUNDS` | não | `50` | Trava de segurança do loop. |
| `RATE_LIMIT_WAIT_SECONDS` | não | `300` | Segundos de espera quando créditos acabam. Para a triagem, o header `retry-after` da API tem precedência quando presente. |
| `RATE_LIMIT_MAX_RETRIES` | não | `10` | Máximo de retentativas por operação antes de desistir com erro. |
| `DEBUG_LOG` | não | — | Path para um arquivo de log. Quando definido, cada chamada a `log()` é gravada lá com timestamp ISO, além do stdout normal. Definido automaticamente pelo servidor quando `WORKFLOW_LOG_DIR` está configurado. |

Comando:

```bash
node --import tsx scripts/sprint-workflow.ts
```

---

## Execução automática via servidor

O servidor pode lançar o workflow automaticamente sempre que uma sprint é ativada via
`kanban_start_sprint`. O processo filho é `detached + unref'd` — o servidor não bloqueia
e pode encerrar independentemente.

Configure as variáveis abaixo no **ambiente do servidor** (`.env` ou env do processo que
sobe o `src/index.ts`):

| Variável | Obrigatória | Default | Para quê |
|---|---|---|---|
| `WORKFLOW_ENABLED` | sim (para ativar) | `false` | Defina `true` para habilitar o auto-launch. |
| `WORKFLOW_SCRIPT_PATH` | sim (quando habilitado) | — | Path absoluto para `packages/server/scripts/sprint-workflow.ts`. Sem default: se faltar, o auto-launch é desligado com um `logger.warn`. |
| `WORKFLOW_LOG_DIR` | não | — | Diretório para logs por sprint. Quando definido, o servidor cria `<dir>/sprint-<id>.log`, redireciona stdout+stderr do processo filho para ele e injeta `DEBUG_LOG=<caminho>` no env do workflow. |

O diretório de trabalho do harness dev vem do `target_repo` do projeto (definido por
`kanban_set_project_repo`), que o servidor usa como `cwd` do processo filho — não há
variável de ambiente para isso.

Os tokens (`ANTHROPIC_API_KEY`, `KANBAN_DEV_TOKEN`, `KANBAN_PM_TOKEN`) são **herdados do
env do servidor** — basta que estejam presentes lá. `KANBAN_DEV_TOKEN` e `KANBAN_PM_TOKEN`
são obrigatórios: o workflow encerra com exit 2 se algum faltar.

```bash
# Exemplo: .env do servidor com auto-launch ligado
WORKFLOW_ENABLED=true
WORKFLOW_SCRIPT_PATH=/abs/path/to/packages/server/scripts/sprint-workflow.ts
WORKFLOW_LOG_DIR=/abs/path/to/logs/sprints

ANTHROPIC_API_KEY=sk-ant-...
KANBAN_DEV_TOKEN=kbt-dev-...
KANBAN_PM_TOKEN=kbt-pm-...
```

Saída no console do servidor ao iniciar:

```
[workflow] auto-launch enabled: script=/abs/path/to/scripts/sprint-workflow.ts
...
[workflow] launched sprint=spr_abc123 pid=12345 log=/abs/path/to/logs/sprints/sprint-spr_abc123.log
```

---

## Limitações conhecidas

- **`claude` CLI no PATH obrigatório.** O runner do dev depende de `spawn('claude', ...)`.
  Se o CLI não estiver instalado ou não estiver no PATH do processo Node, o spawn falha
  imediatamente com mensagem clara.
- **Custo do dev via harness, não via SDK.** `total_cost_usd` vem do JSON de saída do
  harness; o orquestrador não tem acesso aos tokens internos do loop do dev. Para N=1,
  o custo é exato por card; para N>1, é exato por rodada (soma de todos os cards do spawn).
- **Rate limit da triagem não é idempotente em falha parcial.** Se o toolRunner fez
  algumas tool calls (moveu um card) antes de lançar `RateLimitError`, a retentativa
  verá o board nesse estado parcial. Como as mutações kanban são idempotentes por
  `request_id`, mover um card já movido é inócuo — mas o LLM pode re-avaliar cards
  que já foram triados. Aceitável para o nível de criticidade da triagem.
- **Triagem CLOSE depende do LLM.** Quando as regras de triagem estabilizarem, dá para
  promover mais casos para o caminho de código determinístico.
- **Convive, não substitui.** Os skills/CLI seguem úteis para o modo interativo/exploratório;
  o workflow é o caminho **autônomo** para drenar uma sprint inteira.
