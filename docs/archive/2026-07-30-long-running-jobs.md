# Jobs de longa duração administrados pelo servidor

## Contexto

Investigamos um incidente real: dois cards do sprint `sprint-nefyOS5q` ficaram presos em `in_progress` para sempre. Causa raiz, confirmada lendo a transcript bruta da sessão (`~/.claude/projects/.../*.jsonl`) e a documentação oficial do Claude Code:

- O dev agent do `sprint-workflow.ts` roda em turnos headless `claude -p` (um processo por round, sem `--resume`).
- Um comando síncrono (`uv run pytest -q`) estourou o timeout interno do Bash tool (~300s) e foi **auto-promovido a background pela própria CLI** — não foi o agente que pediu `run_in_background`.
- Documentação oficial (`code.claude.com/docs/en/headless#background-tasks-at-exit`) confirma: em modo `-p`, um shell em background é **morto ~5s depois que o processo imprime o resultado final**. Confirmamos isso na prática: o arquivo de output do job ficou com 0 bytes e nenhum processo sobreviveu.
- Um `PreToolUse`/`Stop` hook não resolveria: (a) o agente nunca pediu `run_in_background` explicitamente, a promoção foi automática; (b) existe um bug documentado e conhecido (issue #38651 no repo oficial) em que qualquer `Stop` hook configurado em modo `-p` faz o resultado voltar vazio.
- A instrução de prompt já existente ("NEVER run a long-running command... escale pra humano") não é garantia — foi ela que falhou nesse incidente.

O usuário não quer resolver isso escalando *todo* processo longo para um humano — ele quer administrar processos longos diretamente pelo board, usando o **output contínuo do processo** para diferenciar "está processando" de "travou de verdade" (silêncio, não duração, é o sinal de problema). Decisões já tomadas com o usuário nesta conversa:

- Quando o job termina, o resultado é logado no card e o card volta pra `todo` (libera claim) — pronto pra a *próxima* rodada de dev pegar, não pra retomar a mesma sessão.
- Se o sprint workflow já tiver "drenado" (processo encerrado por falta de trabalho pronto), a finalização do job tenta reacordar o workflow automaticamente, com limite de tentativas por card (evitar loop infinito de reinício).
- Escalação por silêncio: **20 minutos sem output novo** → log `escalate` no card. O job **não é morto** automaticamente — só um humano decide matar, depois de olhar o tail do log.

## Decisões de design e por quê

1. **Estado do job vive num store JSON separado** (`<vault>/.kanban/jobs/<job_id>.json`), não em campo novo no `Card`. Mexer no `Card` implicaria mudar a interface normativa em `packages/shared/src/index.ts`, a serialização (`AtomicWriter`), possivelmente schema SQLite, e as invariantes que `file-watcher.ts` reverte em edição humana. Um job é estado de execução efêmero — mesmo padrão já usado por `PlanningSessionStore` (`packages/server/src/planning/session.ts`) para sessões do wizard. Visibilidade no board vem de duas vias que já existem: entradas em `# Agent Log` (start/stall/finish, reusando o `LogKind` existente — não precisa union novo) e extensão do payload já pollado em `GET /workflow/agents` com um campo `jobs: JobView[]`.

2. **Silêncio de 20min não mata o processo** — só loga `escalate` e emite SSE. `stalled` é computado ao vivo (`now - last_output_at > threshold`), nunca persistido como estado — assim que output novo chega, o job deixa de estar "estagnado" sozinho, sem precisar de uma segunda escrita "resolvido". Um guard (`lastStallLoggedAt`, resetado quando output volta) evita logar `escalate` repetidamente a cada tick do watchdog enquanto o silêncio persiste.

3. **Contador de auto-restart do workflow: por `card_id`, limite 3, nunca resetado.** Por card (não por sprint nem global) é o raio de bloqueio mínimo que ainda resolve o cenário degenerado (um card específico reabrindo o workflow em loop) sem punir os demais cards da sprint. Não resetar é conservador de propósito: o pior caso de parar cedo demais é um humano rodar `kanban_workflow_start` manualmente uma vez (barato); o pior caso de resetar é reabrir o loop infinito que motivou o limite.

4. **Finalização do job nunca briga com intervenção humana.** Só reverte `status→todo`/`assigned_to→null` se o card ainda estiver exatamente como o job deixou (mesmo `status`/`assigned_to` capturados no início do job). Se um humano já mexeu no card enquanto o job rodava, só o log do resultado é escrito.

5. **`kanban_start_job` é a primeira tool `access: 'all'` que spawna processo do lado do servidor** — mesmo nível de confiança que o Bash tool já concede ao dev hoje no mesmo repo/cwd (`dev-settings.json` já libera `Bash` sem restrição); a mudança real é durabilidade (sobrevive ao fim da sessão), não escopo de acesso novo.

## Arquivos e responsabilidades

**`packages/shared/src/index.ts`** — novos tipos, ao lado da seção de workflow (linhas ~378-446): `JobStatus`, `JobView { job_id, card_id, sprint_id, project, command, description, pid, status, started_at, ended_at, exit_code, last_output_at, claimed_by, restart_attempts, stalled? }`, `JobLogResult`. Estender `SSEEventType` com `JOB_STARTED | JOB_STALLED | JOB_FINISHED` + payloads (mesmo padrão de `WorkflowStartedPayload`/`WorkflowExitedPayload`). Estender `AuditOp` com `JOB_STARTED | JOB_FINISHED | JOB_STALLED | JOB_KILLED`.

**`packages/server/src/jobs/store.ts`** (novo) — `JobStore`, espelha `packages/server/src/planning/session.ts`: `save`/`load`/`list`/`listByCard`/`listRunning`, escrita atômica `.tmp`→`fs.rename`. Diretório `<vault>/.kanban/jobs/`. Segundo arquivo pequeno `restart-counters.json` (`Record<card_id, number>`) para o contador do item 3 acima — separado do `Job` porque sobrevive a múltiplos jobs do mesmo card, carregado uma vez no boot.

**`packages/server/src/services/job-runner.ts`** (novo, espelha `packages/server/src/services/workflow-runner.ts` linha a linha na estrutura): classe `JobManager` com `start`, `stop`, `status`, `readLog`, `listForCard`, `listRunning`, e privados `finalize`/`completeCard`/`maybeWakeWorkflow`/`startStallWatchdog`.
- Spawn: `spawn(command, { shell: true, cwd: targetRepo, detached: true, stdio: ['ignore','pipe','pipe'] })` + `child.unref()`, log em `<logDir>/job-<id>.log` via `createWriteStream(..., {flags:'a'})` — idêntico em estrutura ao `WorkflowManager.start` (`workflow-runner.ts:132-147`, já lido e confirmado).
- `last_output_at`: atualizado nos eventos `data` do `child.stdout`/`stderr` (não por tail em polling — mais barato), throttled para persistir no store no máximo 1x/10s; valor em memória é a fonte de verdade enquanto o servidor está de pé.
- Leitura de log por offset: reusar/extrair a lógica de `WorkflowManager.readLog` (`workflow-runner.ts:222-248`, já confirmada) para um helper compartilhado em `packages/server/src/util/log-file.ts`, usado por ambos.
- Watchdog de silêncio: **um único `setInterval`** no `JobManager` (não por job), a cada `JOB_STALL_POLL_MS` (default 60s), varre jobs `running`, compara `now - last_output_at` contra `JOB_STALL_THRESHOLD_MS` (default 20min).
- `JobConfig`/`loadJobConfig(env, paths)`: `JOB_LOG_DIR` (default `<vault>/.kanban/job-logs`), `JOB_STALL_THRESHOLD_MS` (default 1200000), `JOB_STALL_POLL_MS` (default 60000), `JOB_MAX_RESTART_ATTEMPTS` (default 3) — mesmo padrão de `loadWorkflowConfig`.
- Recebe `WorkflowManager` por injeção (construído depois dele em `index.ts`) para `isRunning`/`start` no reacorda.

**`packages/server/src/services/card-writer.ts`** — novo método `completeJob(cardId, expectedStatus, expectedAssignedTo, logEntry, logKind)` ao lado de `defer()` (linhas 503-554, já lido e confirmado como o precedente certo: `assertWritable` + reversão condicional de `status`/`assigned_to` + delegação para `update()` com claims elevadas). Diferença chave: só reverte `status`/`assigned_to` se o card ainda bate com o que foi capturado no início do job (não força). Escrita de sistema usa `JOB_SYSTEM_CLAIMS: ManagerToken = { role:'manager', actor:'system:job-runner' }` — padrão já existente e confirmado em `index.ts:82` (`SYSTEM_CLAIMS` para auto-close de sprint) — `assertWritable` já dá bypass total para `role==='manager'` (`card-shared.ts:6`), então não há fricção de permissão nessa escrita. Retry curto (3 tentativas, re-lendo versão) em vez de propagar 409, já que é uma escrita sem chamador vivo para reagir a conflito.

**`packages/server/src/services/card.ts`** — passthrough `completeJob(...)` para o novo método do `CardWriter`.

**`packages/server/src/server/tool-catalog.ts`** — nova categoria `'Jobs'`; 4 entradas `access: 'all'`: `kanban_start_job`, `kanban_get_job`, `kanban_list_jobs`, `kanban_stop_job` (descrições completas já redigidas na fase de design — deixar claro na descrição do `kanban_start_job` que ele existe especificamente para substituir Bash/backgrounding em comandos que passam de alguns minutos).

**`packages/server/src/server/tool-schemas.ts`** — schemas JSON correspondentes, `additionalProperties: false`, `kanban_start_job` exige `id`/`version`/`command`.

**`packages/server/src/index.ts`** — instanciar `JobStore`, `JobManager` logo após `workflow` (ordem: `WorkflowManager` primeiro). Registrar as 4 tools em `handlers` ao lado de `kanban_workflow_*` (linhas 244-269). Handler de `kanban_start_job` resolve `target_repo` do projeto do card (mesma fonte que `WorkflowManager.start` já usa).

**`GET /workflow/agents`** (`packages/server/src/server/http.ts`) — acrescentar campo `jobs: JobView[]` (via `jobManager.listRunning()` filtrado por sprint) na resposta já existente, reusando a rota que a web já polla em vez de criar uma nova. Custo baixo, incluir no escopo.

**`packages/server/scripts/sprint-workflow.ts`** — `buildDevPrompt` (linhas 284-299): substituir o parágrafo "NEVER run a long-running command... hand it to a human" por instrução de usar `kanban_start_job`, continuar pegando outros cards prontos enquanto o job roda, e que a finalização/reversão pra `todo` é automática — escalar pra humano só se `kanban_start_job` falhar ou o log indicar que precisa mesmo de decisão humana.

**`.claude/skills/kanban-dev-agent/SKILL.md`** — atualizar contagem de tools (8→12), substituir a seção "Long-running commands" pelo novo fluxo, e `reference/protocol.md` da mesma skill com os schemas das 4 tools novas (mesmo formato usado para `kanban_defer_card`).

**`docs/for-agents/tool-catalog.md`** — regenerar via `pnpm run gen:tools` depois do `tool-catalog.ts` atualizado (arquivo gerado, não editar à mão).

## Fora de escopo (mencionar, não implementar agora)

- UI web mostrando jobs ativos no board além do campo cru em `GET /workflow/agents` — vira follow-up trivial uma vez que o campo existir na resposta.
- Sandboxing/allowlist de comandos para `kanban_start_job` — mesmo nível de confiança que `Bash` já tem hoje.
- Reidratar jobs em memória após restart do servidor com processo filho órfão ainda vivo — mesmo gap de durabilidade já aceito e documentado no `WorkflowManager` (o log em disco continua legível via `readLog` mesmo sem entrada em memória).

## Testes

- `packages/server/tests/service/job-manager.test.ts` (novo, espelha `tests/service/workflow-manager.test.ts`): spawn de comando curto real, checa `status`/`readLog`/finalização/reversão do card; um teste com comando silencioso e `stallThresholdMs`/`pollIntervalMs` pequenos injetados via config para validar o watchdog sem esperar 20 minutos de verdade; um teste do contador de restart (mock de `WorkflowManager.start`, 4 finalizações seguidas no mesmo card, confirma que a 4ª não tenta de novo e loga escalate).
- Teste de integração das 4 tools MCP novas (schema, access level, fluxo start→get→stop) no arquivo onde `kanban_workflow_start` já é testado hoje.
- `packages/server/tests/integration/http.test.ts` — cobrir o campo `jobs` novo em `GET /workflow/agents`.

## Verificação end-to-end

1. `pnpm run typecheck` e `pnpm run test` (server) — todo o novo código deve passar junto com a suíte existente, sem quebrar `workflow-manager.test.ts` nem os testes de card.
2. `pnpm run gen:tools` e conferir que `docs/for-agents/tool-catalog.md` ganhou as 4 entradas em `Jobs` com os checks de Dev corretos.
3. Manual, com `PLANNING_STUB` irrelevante aqui (isso é sobre o dev harness real, não o wizard): subir o servidor, chamar `kanban_start_job` via MCP (ou um script smoke novo em `packages/server/scripts/`, no padrão dos `smoke-*.mjs` existentes) com um comando como `sleep 5 && echo done` num card real; `kanban_get_job` deve mostrar `status: running` e depois `succeeded`; confirmar no arquivo `.md` do card que apareceu a entrada de log e que `status`/`assigned_to` voltaram (se o card não foi mexido por fora).
4. Repetir com um comando silencioso mais longo que o `JOB_STALL_THRESHOLD_MS` configurado baixo via env (ex. `JOB_STALL_THRESHOLD_MS=5000 JOB_STALL_POLL_MS=1000 sleep 30`), confirmar que aparece exatamente uma entrada `escalate` no card enquanto o job ainda roda, e que o job não é morto.
5. Cenário de auto-restart: rodar um sprint workflow até drenar, então finalizar um job pendente daquele sprint e confirmar via SSE/log que `kanban_workflow_start` foi disparado automaticamente; repetir 4x no mesmo card e confirmar que a 4ª finalização não reinicia o workflow e loga o aviso de limite atingido.
