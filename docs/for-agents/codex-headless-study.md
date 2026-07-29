# Codex headless no sprint workflow

Este estudo avalia como adicionar o Codex CLI em modo headless ao workflow de
sprint do ObsidianKan sem perder o contrato central do produto: o board e o MCP
continuam sendo a fonte de verdade, e cada agente age com sua propria identidade
via token.

## Estado atual

Hoje existem dois usos distintos do Claude CLI headless:

1. **Execucao DEV no sprint workflow** (`packages/server/scripts/sprint-workflow.ts`)
   - O workflow roda como processo Node separado.
   - Cada rodada DEV faz `spawn('claude', ...)` dentro de `TARGET_REPO`.
   - O comando usa `-p`, `--strict-mcp-config`, `--mcp-config`, `--settings`,
     `--permission-mode acceptEdits`, `--output-format json` e `--name`.
   - O token DEV entra por `KANBAN_DEV_TOKEN` e o MCP HTTP aponta para
     `http://127.0.0.1:9375/mcp`.
   - A saida JSON do harness fornece `is_error`, `result`, `session_id`,
     `usage`, `modelUsage`, `total_cost_usd` e `num_turns`.

2. **Wizard KAD de planejamento** (`packages/server/src/planning/claude-runner.ts`)
   - Cada turno faz `claude -p --output-format json`.
   - `--resume <session_id>` preserva contexto entre passos.
   - Nao ha MCP nem escrita direta no repo; o runner so gera texto/JSON e o
     servidor materializa o resultado.

O sprint workflow tambem usa a Anthropic API diretamente para a triagem PM dos
cards em `review`. Essa parte nao passa pelo Claude CLI: usa `betaZodTool` para
expor uma sublista de tools `kanban_*` ao modelo com token PM.

O provisionamento atual esta acoplado ao Claude Code:

- `workflow-readiness` copia `.claude/skills/kanban-dev-agent`,
  `.claude/skills/kanban-pm-agent` e `.claude/skills/kanban-manager-agent`.
- Escreve `.claude/mcp.json`.
- Escreve `.claude/settings.local.json` com `KANBAN_TOKEN` e
  `KANBAN_DEV_TOKEN`.
- Ajusta `.claude/skills/kanban-pm-agent/dev.mcp.json` para a porta atual.

A decisao arquitetural mais importante continua valida para Claude ou Codex:
**o token e a identidade**. Um DEV precisa ser outro processo, com outro token,
porque `kanban_claim_card`, auditoria, atribuicao de custo e RBAC dependem das
claims do token. Subagents que compartilham a conexao MCP do PM quebram essa
fronteira.

## Comparacao: Claude CLI e Codex CLI

### Claude CLI, como usado hoje

Pontos fortes para o produto:

- `--strict-mcp-config` garante que o DEV veja apenas o MCP declarado para ele.
- `--settings` permite negar skills PM/manager no plano do cliente.
- `--output-format json` entrega um objeto final facil de parsear.
- `--resume` entrega continuidade explicita por `session_id`.
- O harness reporta custo em USD e tokens, incluindo cache, de forma que o
  workflow consegue registrar uso real em `kanban_log_workflow_usage`.

Dependencias especificas:

- O formato JSON e os nomes de campos sao contrato do Claude CLI, nao do
  ObsidianKan.
- `modelUsage` e `total_cost_usd` sao usados para metricas e custo por round.
- A deteccao de rate limit hoje olha mensagens de erro do harness Claude.

### Codex CLI, conforme CLI local e manual oficial

O Codex CLI instalado localmente expoe:

- `codex exec`: modo nao interativo.
- `codex exec --json`: eventos JSONL em stdout.
- `codex exec --output-schema <file>`: resposta final estruturada.
- `codex exec -o <file>`: salva a ultima mensagem.
- `codex exec resume`: continua sessao anterior, inclusive por `--last` ou ID.
- `--sandbox workspace-write`, `--ask-for-approval never` e `-C <dir>` para
  rodar em automacao no repo alvo.
- `codex mcp add <name> --url <url> --bearer-token-env-var <ENV_VAR>` para MCP
  HTTP autenticado por bearer token.

O manual oficial do Codex tambem documenta que:

- Codex carrega MCP por `~/.codex/config.toml` ou `.codex/config.toml` em
  projetos confiaveis.
- Servidores MCP HTTP suportam `bearer_token_env_var`.
- `AGENTS.md` e o mecanismo de skills/plugins sao o caminho de instrucoes
  duraveis no ecossistema Codex.
- `codex exec` em scripts deve usar permissoes explicitas e o menor sandbox
  suficiente.

Diferenças importantes para o produto:

- Nao ha flag equivalente documentada a `--strict-mcp-config`.
- Nao ha equivalente direto documentado a `--settings` com deny de skills
  especificas.
- A saida principal de automacao e JSONL de eventos, nao um unico JSON final no
  formato Claude.
- Custo em USD pode nao estar disponivel no mesmo shape; tokens aparecem em
  eventos de conclusao, mas o campo autoritativo equivalente a
  `total_cost_usd` nao deve ser assumido.

## Features preservadas, em risco e fora do primeiro corte

### Preservadas

Estas features pertencem ao servidor/board e devem sobreviver sem depender do
provider do harness:

- Board como fonte de verdade.
- Tokens PM/DEV separados.
- RBAC server-side por `agent_type`.
- `pick_next -> claim -> in_progress -> log -> done/review`.
- Controle de concorrencia por `version`.
- Idempotencia por `request_id`.
- SSE de movimento dos cards.
- Log incremental do workflow em disco.
- `kanban_workflow_stop` matando o process group.
- Execucao dentro de `TARGET_REPO`.

### Em risco na migracao para Codex

Estas features precisam de adapter ou perda explicitamente aceita:

- **Isolamento MCP estrito.** Claude tem `--strict-mcp-config`; Codex deve usar
  config isolada ou `CODEX_HOME` dedicado para nao herdar MCPs globais.
- **Bloqueio de skills PM/manager.** Claude usa `dev-settings.json`; Codex deve
  substituir isso por `AGENTS.md`/prompt e, se necessario, `CODEX_HOME` dedicado
  sem plugins/skills PM.
- **Usage/cost.** O sprint workflow espera `input`, `output`, cache, USD,
  modelo e turns. Codex precisa de parser JSONL e politica clara quando USD ou
  cache nao vierem.
- **Rate limit.** A regex atual e Claude-centric; Codex precisa de padroes
  proprios de erro e exit code.
- **Resume.** Claude retorna `session_id` no JSON final; Codex usa
  `codex exec resume`, mas o workflow precisa capturar o `thread_id` dos eventos
  JSONL para retomar a sessao certa.
- **Custo por card.** Quando `DEV_DRAIN_LIMIT=1`, o custo por card so continua
  exato se o Codex reportar usage por run de forma confiavel.

### Fora do primeiro corte

Nao vale migrar tudo de uma vez:

- **Triagem PM via LLM** deve continuar Anthropic SDK por enquanto. Ela depende
  de `betaZodTool`, pricing Anthropic e um tool loop controlado.
- **Wizard KAD** deve continuar `ClaudeRunner` inicialmente. Ele tem contrato
  proprio de `--resume`, JSON parseavel e timeout/cancelamento ja testados.

O primeiro corte deve mirar apenas o **DEV agent headless**.

## Arquitetura proposta

Adicionar um nivel de abstracao entre o loop deterministico do workflow e o
harness de DEV.

```ts
interface DevHarnessRunner {
  run(prompt: string): Promise<DevRun>
}

interface DevRun {
  isError: boolean
  result: string
  sessionId?: string
  model: string
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheCreation: number
    usd: number
  }
  numTurns: number
  stderrTail: string
}
```

Providers:

- `ClaudeDevRunner`: move o codigo atual de `runClaudeDev` sem mudar
  comportamento.
- `CodexDevRunner`: chama `codex exec` e normaliza JSONL/eventos para `DevRun`.

Selecao:

```bash
DEV_AGENT_PROVIDER=claude   # default atual
DEV_AGENT_PROVIDER=codex
```

Defaults de seguranca para Codex:

```bash
codex exec \
  --json \
  --sandbox workspace-write \
  --ask-for-approval never \
  --cd "$TARGET_REPO" \
  --output-schema "$CODEX_RESULT_SCHEMA" \
  "$PROMPT"
```

O uso de `--ask-for-approval never` e necessario porque o processo e headless.
Compensacoes:

- O sandbox deve ser `workspace-write`, nao `danger-full-access`.
- O workflow deve rodar em repo controlado pelo usuario.
- Para qualquer diretorio extra necessario, usar `--add-dir` explicitamente.

### Configuracao MCP para Codex

Provisionar arquivos paralelos aos atuais, sem substituir `.claude`:

```text
TARGET_REPO/
  .codex/
    config.toml
  AGENTS.md
```

Exemplo de `.codex/config.toml`:

```toml
[mcp_servers.kanban]
url = "http://127.0.0.1:9375/mcp"
bearer_token_env_var = "KANBAN_DEV_TOKEN"
required = true
enabled = true
```

O runner deve iniciar o Codex com ambiente contendo:

```bash
KANBAN_DEV_TOKEN=<dev token>
```

Para reduzir heranca de configuracao global, ha duas opcoes:

1. Usar `.codex/config.toml` do projeto e documentar que o projeto precisa ser
   confiavel para Codex carregar config local.
2. Usar `CODEX_HOME=<TARGET_REPO>/.codex-home/kanban-dev` com config gerada
   pelo servidor, evitando MCPs globais e plugins do usuario.

Recomendacao: **usar `CODEX_HOME` dedicado para o DEV headless**. Isso chega
mais perto do isolamento de `--strict-mcp-config` e evita que uma configuracao
global do usuario exponha MCPs extras ao agente.

### Instrucoes DEV para Codex

O conteudo de `.claude/skills/kanban-dev-agent/SKILL.md` e
`reference/protocol.md` deve virar um `AGENTS.md` ou referencia carregada no
prompt do Codex DEV.

O prompt do workflow continua curto, como hoje, e controla apenas granularidade:

- `DEV_DRAIN_LIMIT=1`: escolher exatamente um card e parar.
- `DEV_DRAIN_LIMIT>1`: trabalhar ate N cards ou parar em bloqueio/review/vazio.

O protocolo completo fica em instrucoes duraveis:

- Ferramentas permitidas.
- `claim` antes de mutar.
- `version` em toda mutacao.
- Recuperacao de `409 conflict`.
- Escalacao por log + move para `review`.
- Nao inventar token counts.

## Impacto no produto

### API/MCP

Nao e necessario mudar as tools `kanban_*` para suportar Codex. O MCP ja e o
contrato correto.

Mudancas recomendadas:

- Atualizar descricoes de workflow para falar em "agent harness" ou "provider"
  em vez de "Claude" quando o texto for publico.
- Adicionar `DEV_AGENT_PROVIDER` em `docs/reference/config.md`.
- Documentar que tokens continuam vindo de `settings.local.json` ou ambiente.

### Readiness/UI

Hoje `WorkflowReadinessResult` mistura "workflow pronto" com arquivos `.claude`.
Para coexistencia, ele deve evoluir sem quebrar a UI:

```ts
interface WorkflowReadinessResult {
  target_repo: string
  repo_exists: boolean
  skills: SkillFileCheck[]       // legado Claude
  config_files: ConfigFileCheck[]
  tokens: ...
  providers?: {
    claude?: ProviderReadiness
    codex?: ProviderReadiness
  }
  all_ok: boolean
}
```

No primeiro corte, a UI pode continuar mostrando o checklist atual e acrescentar
um bloco simples de provider:

- Claude: pronto/faltando CLI/config.
- Codex: pronto/faltando CLI/config.
- Provider ativo: valor de `DEV_AGENT_PROVIDER`.

### Metricas

`packages/shared/src/index.ts` ja tem preparo parcial para modelos OpenAI via
`providerOf(model)` e entries `gpt-*`/`codex-*` na tabela estimada.

Politica recomendada:

- Se Codex reportar usage e modelo: registrar normalmente via
  `kanban_log_workflow_usage`.
- Se Codex nao reportar USD: registrar `cost_usd=0` apenas se o tipo exigir
  numero, mas exibir no log que custo nao veio do harness.
- Nao inventar custo por card quando o harness nao fornece uso confiavel.

## Plano incremental

1. **Documento e decisao**
   - Manter este estudo como referencia.
   - Concordar que o primeiro corte e DEV-only.

2. **Refactor sem mudanca funcional**
   - Extrair `ClaudeDevRunner` de `runClaudeDev`.
   - Manter `DEV_AGENT_PROVIDER=claude` como default.
   - Garantir que os testes atuais continuam passando.

3. **Codex runner**
   - Implementar `CodexDevRunner`.
   - Parsear `codex exec --json`.
   - Capturar `thread.started.thread_id` como `sessionId`.
   - Capturar `turn.completed.usage` para tokens.
   - Capturar mensagem final como `result`.
   - Marcar falha em `turn.failed`, evento `error` ou exit code nao zero.

4. **Provisionamento Codex**
   - Gerar `CODEX_HOME` dedicado ou `.codex/config.toml`.
   - Gerar instrucoes DEV em `AGENTS.md`.
   - Checar `command -v codex` no readiness.
   - Validar URL MCP e token env.

5. **UI e docs**
   - Atualizar readiness para mostrar providers.
   - Atualizar `agent-runbook.md`, `sprint-workflow.md` e
     `docs/reference/config.md`.

6. **Experimento controlado**
   - Rodar um repo pequeno com `DEV_DRAIN_LIMIT=1`.
   - Comparar logs, claims, movimento de cards, metricas e paradas.
   - So depois liberar `DEV_AGENT_PROVIDER=codex` em uso real.

## Testes recomendados

- Unit: provider default e provider invalido.
- Unit: parser Claude preserva o shape atual.
- Unit: parser Codex JSONL cobre sucesso, erro, usage ausente e thread ausente.
- Unit: rate-limit Codex com mensagens conhecidas.
- Service: readiness com Claude existente e Codex ausente.
- Service: readiness com Codex existente e `.codex` faltando.
- Service: tokens do repo continuam vencendo env global.
- Integration/manual: `kanban_workflow_start` com `DEV_AGENT_PROVIDER=claude`.
- Integration/manual: `kanban_workflow_start` com `DEV_AGENT_PROVIDER=codex`.
- Manual: `kanban_workflow_stop` mata o workflow e o processo Codex filho.

## Decisao recomendada

Adicionar Codex como provider alternativo e manter Claude como default ate
paridade operacional.

Nao devemos substituir o workflow inteiro nem migrar PM triage/KAD no mesmo
movimento. O risco principal nao e o MCP nem o board; esses ja sao
provider-neutral. O risco esta nos detalhes de harness: isolamento de tools,
formato de output, contabilizacao de custo, rate limit e resume.

O caminho mais seguro e:

1. Interface provider-neutral para DEV.
2. Claude preservado sem mudanca.
3. Codex DEV atras de `DEV_AGENT_PROVIDER=codex`.
4. `CODEX_HOME` dedicado para isolamento.
5. Paridade validada em sprint pequena antes de tornar default.

## Fontes consultadas

- `packages/server/scripts/sprint-workflow.ts`
- `packages/server/src/planning/claude-runner.ts`
- `packages/server/src/services/workflow-runner.ts`
- `packages/server/src/services/workflow-readiness.ts`
- `.claude/skills/kanban-dev-agent/SKILL.md`
- `.claude/skills/kanban-pm-agent/spawn-dev.sh`
- `docs/for-agents/agent-runbook.md`
- `docs/for-agents/sprint-workflow.md`
- Manual oficial do Codex atualizado em 2026-07-28:
  - CLI command reference
  - Model Context Protocol
  - Non-interactive mode
  - Configuration reference
  - Custom instructions with `AGENTS.md`
