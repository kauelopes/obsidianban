# Lacunas Identificadas — ObsidianKan

> **Documento companheiro de [MELHORIAS_HARNESS.md](MELHORIAS_HARNESS.md).**
> Data: 2026-09-20
> Enquanto o documento principal analisa o projeto contra o estado da arte em *agent harnesses*,
> este registra o que **nenhum dos dois** cobria — lacunas encontradas ao revisar a própria análise.
> Ordenadas por "isto mudaria uma decisão", não por completude.

---

## Resumo

| # | Lacuna | Custo | Prioridade sugerida |
|---|---|---|---|
| 1 | [Vault sem desfazer](#1-o-vault-não-tem-desfazer) | baixo | **antes de tudo** |
| 2 | [Escalada sem canal de notificação](#2-a-escalada-do-supervisor-não-tem-para-onde-ir) | baixo | **P0** |
| 3 | [Disjuntor de gasto](#3-orçamento-de-recuperação-existe-orçamento-de-gasto-não) | baixo | **P0** |
| 4 | [Migração de schema do vault](#4-não-há-história-de-migração-para-o-vault) | médio | P1 |
| 5 | [Teste e eval da camada de agente](#5-nada-testa-a-camada-de-agente) | alto | **P0/P1** |
| 6 | [Dogfooding circular](#6-o-dogfooding-é-circular) | baixo | P2 |
| 7 | [Segredos expostos ao worker](#7-prompt-injection--segredos-no-worker) | médio | P2 |
| — | [Atenção humana como gargalo](#8-consideração-a-atenção-humana-vira-o-gargalo) | — | consideração de design |

---

## 1. O vault não tem desfazer

### Sintoma
Todo o desenho trata o vault como fonte de verdade, e agentes escrevem nele. Se um agente
corromper quarenta cards, não existe caminho de recuperação de um comando.

### Por que importa
O audit log NDJSON permite **reconstruir** o que aconteceu, mas isso é forense, não `undo`.
O SQLite é índice descartável e reconstruível — o vault não é. É o único dado do sistema cuja
perda é irreversível.

O risco cresce com tudo que foi proposto: execução autônoma, supervisor que retoma sozinho,
migração de schema em massa.

### Evidência
- Escrita atômica (`packages/server/src/writer/atomic.ts`) protege contra corrupção **durante**
  a escrita, não contra uma escrita errada bem-sucedida
- `extractBodyRaw` (`cards/serialize.ts`) recupera o corpo humano de frontmatter corrompido —
  o autor já previu essa classe de dano, mas caso a caso
- Não há snapshot, versionamento nem rollback do vault como um todo

### Proposta
**O vault deve ser um repositório git com commit automático.** É prática comum entre usuários de
Obsidian e resolve de uma vez: diff, blame, rollback, e histórico legível.

Commit por operação é excessivo; commit por lote (a cada N minutos, ou ao fim de cada rodada de
sprint) é suficiente e mantém o histórico navegável.

### ⚠️ Verificação pendente
**Não sei se o vault de produção já está versionado.** O `.env` real aponta para um caminho que
não foi inspecionado. Se já estiver em git, esta lacuna se reduz a "garantir commit automático".

---

## 2. A escalada do supervisor não tem para onde ir

### Sintoma
A camada de supervisão (§12 do documento principal) prevê `"human_notification": true` como
resultado de decisão. **Não existe canal de notificação no sistema.**

### Por que importa
Sem canal, "escalar para humano" significa na prática "parar e esperar ser descoberto de manhã" —
que é exatamente o incidente de sprint presa que a camada deveria prevenir.

E vale além do supervisor: **approval gate que ninguém vê não é aprovação, é deadlock.** Toda a
discussão sobre `PreToolUse` com `permissionDecision: "ask"` pressupõe alguém disponível para
responder.

### Evidência
- O dashboard existe, mas é superfície de *pull* — ninguém está olhando às 03h47
- Comparação: Hermes bloqueia num `threading.Event` aguardando resposta humana e entrega por
  gateway; OpenClaw tem 15+ canais de mensageria
- ObsidianKan tem zero canais de *push*

### Proposta
Um bot de Telegram. É o canal mais simples de configurar (ambos os harnesses de referência o
citam como ponto de partida) e cobre os três casos:

1. Supervisor escalando falha não recuperável
2. Approval gate pedindo decisão
3. Relatório de fim de sprint

Meia tarde de trabalho. Pré-requisito real de qualquer execução não supervisionada.

---

## 3. Orçamento de recuperação existe; orçamento de gasto, não

### Sintoma
O supervisor tem limite de tentativas. O sistema **não tem limite de consumo**.

### Por que importa
Existe medição de custo precisa e **nenhum mecanismo que aja sobre ela**. Com execução autônoma
e retomada automática, é possível queimar a cota do dia inteiro numa sprint que não deveria ter
continuado — e descobrir isso depois.

É a diferença entre instrumento e disjuntor. Você tem o primeiro.

### Evidência
- `token_log` — auditoria de tokens e custo por operação
- `terminal_usage` — ingestão incremental de `~/.claude/projects/**/*.jsonl` com offset de bytes
- Rotas de métricas e widgets no dashboard
- Nenhum ponto no código onde uma medição de custo interrompe uma execução

### Proposta
Tetos configuráveis, verificados antes de cada rodada:

| Escopo | Sugestão |
|---|---|
| Por card | limite de tokens/custo |
| Por sprint | limite acumulado |
| Por dia | limite global do sistema |

Ao estourar: parar, marcar, registrar no audit log e **notificar** (lacuna 2). Nunca continuar
silenciosamente.

Preço de modelo hardcoded em três lugares (script, shared, terminal-usage) precisa ser
consolidado primeiro — já consta na lista de higiene do documento principal.

---

## 4. Não há história de migração para o vault

### Sintoma
As migrações existentes (`packages/server/src/db/database.ts`) cobrem o SQLite via
`ALTER TABLE ... ADD COLUMN` condicional. O vault não tem equivalente.

### Por que importa
O documento principal propõe campos novos:

- `Card`: `parallel_group`, `expected_files`, `acceptance` (padrão Spec Kit)
- `ProjectMeta`: `requires_capabilities`, `executor`

Cards são **arquivos markdown com frontmatter YAML** — centenas deles. Adicionar campo significa
reescrever arquivos em massa, que é precisamente a operação mais arriscada do sistema.

E o SQLite pode ser reconstruído se a migração der errado; o vault não.

### Evidência
- `cardFromFrontmatter` valida campo a campo e **lança erro** se o tipo divergir — uma migração
  malfeita quebra a leitura de todos os cards de uma vez
- `startup/reconcile.ts` resincroniza SQLite a partir do vault, não o contrário
- Nenhum script de migração de vault em `packages/server/scripts/`

### Proposta
Migrador versionado, com as propriedades mínimas:

1. Versão de schema registrada no `_meta.json` do projeto
2. Dry-run que reporta o que mudaria sem escrever
3. Idempotente — rodar duas vezes não causa dano
4. Depende da lacuna 1 (git no vault) como rede de segurança

**Precede qualquer mudança no schema do Card.**

---

## 5. Nada testa a camada de agente

### Sintoma
61 arquivos de teste cobrem servidor e web. **Zero cobrem comportamento de agente.**

### Por que importa
Esta é a lacuna que compromete o roadmap inteiro. Cada mudança proposta — memória injetada,
tools escopadas por papel, gate de verificação, supervisor, migração para o Agent SDK — **altera
o comportamento do agente**. Sem medição, não há como saber se melhorou ou piorou.

É a mesma família de problema do CI ausente: sem verificação, o resto é fé. A diferença é que
comportamento de agente é não-determinístico, então exige técnica própria.

### Evidência
- `PLANNING_STUB=true` (`planning/stub-runner.ts`, `stub-materialize.ts`) gera turnos sintéticos
  sem LLM real — **a ideia certa, só não generalizada**
- Não há equivalente para o dev agent nem para a triagem PM
- Os ~35 scripts `smoke-*.mjs` são QA manual exploratório, não regressão automatizada
- `coverage/` desatualizado (junho, código de agosto) sugere que cobertura não faz parte do fluxo

### Proposta
Três camadas, da mais barata à mais cara:

**a) Generalizar o stub.** O que existe para o wizard vale para dev e triagem. Permite testar
orquestração, transições de estado e tratamento de erro sem gastar token.

**b) Transcripts dourados.** Gravar sessões reais, reproduzir contra o código novo, afirmar sobre
**resultados** (o card mudou de coluna? o arquivo certo foi tocado? o custo ficou na faixa?), não
sobre o texto gerado.

**c) Evals de comportamento.** Um conjunto pequeno de cenários com critério de sucesso objetivo,
rodado quando algo muda no prompt, nas tools ou na memória.

A camada (a) é barata e já tem meio caminho andado. A (b) destrava o resto.

---

## 6. O dogfooding é circular

### Sintoma
O ObsidianKan é construído usando o ObsidianKan. Quando `target_repo` aponta para o próprio
repositório, o dev agent pode quebrar a ferramenta que usa para reportar.

### Por que importa
Modo de falha específico e não coberto:

```
agente edita packages/server/src/...
servidor reinicia quebrado
agente não consegue mover o card nem escrever no Agent Log
→ estado inconsistente E nenhum registro do porquê
```

O worktree isolado (P2.11) protege a árvore de arquivos, mas **não** resolve: o servidor com que
o agente fala é o que está rodando.

### Evidência
- `.claude/skills/kanban-dev-agent`, `kanban-pm-agent`, `kanban-manager-agent` existem no repo
- O incidente de sprint presa documentado no `CLAUDE.md` é desta família
- O aviso do `CLAUDE.md` para **nunca** subir o servidor à mão existe pelo mesmo motivo

### Proposta
Tratar o próprio ObsidianKan como projeto de categoria especial:

- Nunca executar sem supervisão quando `target_repo` é o próprio repositório
- Ou: o agente fala com uma **instância separada** do servidor (a do Pi), não com a que está
  editando
- A segunda opção é a boa, e cai de graça com a arquitetura Pi + workers (§11): o agente roda no
  worker, o servidor com que ele fala está no Pi. **A separação de planos resolve o dogfooding
  por consequência.**

---

## 7. Prompt injection + segredos no worker

### Sintoma
A análise principal identificou injection via corpo de card levando a execução de comando.
Faltou o outro lado: **o worker tem acesso de leitura aos repositórios de trabalho, com os
arquivos de credencial dentro deles.**

### Por que importa
O corpo de um card é markdown que o agente lê e trata como instrução em potencial. O agente tem
ferramentas de arquivo e Bash. Os repositórios da máquina contêm `.env`, tokens, chaves.

O caminho da exfiltração é curto e não exige malícia sofisticada — um card mal escrito basta.

### Evidência
- `--permission-mode acceptEdits` no `target_repo` real
- `kanban_start_job` → `spawn(command, { shell: true })` sem allowlist
  (`packages/server/src/services/job-runner.ts`)
- O registro de worker proposto (§11.4) lista `repos` com caminhos pessoais e de trabalho na
  mesma máquina
- Referência: o Hermes faz varredura de segurança **antes de injetar memória**, detectando
  especificamente exfiltração via `curl`/`wget` com variáveis de ambiente

### Proposta
1. **Escopo de leitura explícito por projeto** — o worker só enxerga o `target_repo` daquele card
2. **Allowlist de comando** (já é P0.3) com atenção a `curl`, `wget`, `nc` e redirecionamento
3. **Scan de exfiltração** no corpo do card antes de injetar no prompt, no modelo do Hermes
4. Considerar backend de execução em container (padrão Hermes: *"mesma ferramenta, blast radius
   diferente"*) para projetos de terceiros

---

## 8. Consideração: a atenção humana vira o gargalo

Não é lacuna técnica — é consequência de sucesso, e vale desenhar antes de sentir.

Se os agentes ficarem bons, o sistema passa a produzir cards prontos, branches para revisar e
aprovações pendentes mais rápido do que uma pessoa processa. O gargalo se desloca da execução
para a revisão.

Perguntas que valem resposta antes de acelerar:

- Revisão em lote ou contínua?
- O PM agent pode fechar card sozinho quando o gate de verificação passa, ou tudo espera humano?
- Qual o tamanho de fila de review que indica que o sistema está rápido demais para você?

O modelo do Vibe Kanban (worktree isolado → PR) transforma isso explicitamente em revisão de PR.
É uma resposta possível; vale escolher conscientemente em vez de herdar.

---

## Como isto muda o roadmap

Proposta de reordenação em relação ao [MELHORIAS_HARNESS.md §13](MELHORIAS_HARNESS.md#13-roadmap-priorizado):

**Antes de tudo (nem entra no roadmap — é higiene de sobrevivência)**
- Vault em git com commit automático *(lacuna 1)*

**Sobe para P0**
- Canal de notificação *(lacuna 2)* — pré-requisito de qualquer execução não supervisionada
- Disjuntor de gasto *(lacuna 3)*
- Generalizar o stub de agente *(lacuna 5a)* — junto com o CI, pela mesma razão

**P1**
- Migrador versionado do vault *(lacuna 4)* — **precede** os campos do Spec Kit
- Transcripts dourados *(lacuna 5b)*

**P2**
- Política especial de dogfooding *(lacuna 6)* — em boa parte resolvida pela separação Pi/worker
- Escopo de leitura do worker + scan de exfiltração *(lacuna 7)*

---

## Verificações pendentes

Itens deste documento que dependem de fato ainda não confirmado:

1. **O vault de produção está sob git?** Determina se a lacuna 1 é "criar" ou "automatizar".
   O caminho está no `.env`, não inspecionado.
2. **Quantos cards existem no vault de produção?** Determina o custo real da lacuna 4.
3. **Existe algum canal de notificação já configurado** em `.env` que eu não tenha visto?

---

## Documentos relacionados

- [MELHORIAS_HARNESS.md](MELHORIAS_HARNESS.md) — análise principal, roadmap e decisões arquiteturais
- [docs/harness/PICOCLAW.md](docs/harness/PICOCLAW.md) · [OPENCLAW.md](docs/harness/OPENCLAW.md) · [HERMES.md](docs/harness/HERMES.md) · [CLAUDE_AGENT_SDK.md](docs/harness/CLAUDE_AGENT_SDK.md)
- `docs/for-developers/vistoria-2026-09-05.md` — autoavaliação anterior, com achados P0–P3
