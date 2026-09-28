# Melhorias de Harness — ObsidianKan

> **Documento de análise arquitetural.**
> Data: 2026-09-20
> Escopo: avaliar o ObsidianKan à luz do estado da arte em *agent harnesses* abertos e definir um caminho de evolução.
> Fontes internas: `docs/for-developers/vistoria-2026-09-05.md`, `CLAUDE.md`, leitura direta do código.
> Fontes externas: ver [Referências](#referências).

---

## Sumário

1. [Veredito](#1-veredito)
2. [O que é um harness](#2-o-que-é-um-harness)
3. [Os oito temas de arquitetura](#3-os-oito-temas-de-arquitetura)
4. [Harnesses de referência pesquisados](#4-harnesses-de-referência-pesquisados)
   - [Fichas técnicas detalhadas](#fichas-técnicas-detalhadas)
5. [O que o ObsidianKan já acertou](#5-o-que-o-obsidiankan-já-acertou)
6. [Crítica tema a tema](#6-crítica-tema-a-tema)
7. [Os três buracos críticos](#7-os-três-buracos-críticos)
8. [A troca central: subprocess → Agent SDK](#8-a-troca-central-subprocess--agent-sdk)
9. [Posicionamento de mercado](#9-posicionamento-de-mercado)
10. [Evoluir vs reescrever](#10-evoluir-vs-reescrever)
11. [Arquitetura de deployment — Pi + workers](#11-arquitetura-de-deployment--pi--workers)
12. [A camada de supervisão](#12-a-camada-de-supervisão)
13. [Roadmap priorizado](#13-roadmap-priorizado)
    - ⚠️ ver também [LACUNAS.md](LACUNAS.md) — sete lacunas que este documento não cobria, com proposta de reordenação
14. [Questões em aberto](#14-questões-em-aberto)
15. [Referências](#referências)

---

## 1. Veredito

**Não reescrever. Evoluir.**

O ObsidianKan já chegou, de forma independente, à arquitetura que a pesquisa nos harnesses abertos
(OpenClaw, Hermes Agent, PicoClaw) aponta como correta. As fundações estão certas. O que falta são
**três camadas aditivas** — memória, verificação e permissão — e **uma troca cirúrgica de peça**:
migrar a integração LLM de subprocesso do CLI para o Claude Agent SDK.

Nenhuma das lacunas exige mexer no modelo de dados. Nenhuma exige demolição.

---

## 2. O que é um harness

Um LLM é uma função pura: texto entra, texto sai. Não tem estado, não lembra nada entre chamadas,
não tem mãos. Não lê arquivo, não roda comando, não sabe que horas são.

**O harness é tudo que transforma essa função num agente.**

```
Agent = Model + Harness
```

Corolário: *se você não é o modelo, você é o harness.* Toda a engenharia possível está desse lado.

### O loop

No coração de todo harness existe o mesmo ciclo, formulado pela Anthropic como:

```
coletar contexto → agir → verificar → repetir
```

Mecanicamente:

1. Monta um contexto (system prompt + histórico + estado + schemas das ferramentas)
2. Chama o modelo
3. Modelo devolve `stop_reason: "tool_use"` pedindo uma ferramenta
4. O harness **executa** a ferramenta — é aqui que ele tem mãos
5. Devolve o resultado ao contexto
6. Volta ao passo 2, até o modelo parar de pedir ferramenta

Isso cabe em ~40 linhas. Por isso o loop virou commodity e o Agent SDK já o entrega pronto.
**O loop nunca foi a parte difícil.** A parte difícil é tudo em volta.

### Por que isso importa mais que o modelo

O mesmo Claude Opus pontua diferente em harnesses diferentes no Terminal Bench. Uma equipe
saiu de Top 30 para Top 5 mudando **apenas o harness**. Um modelo decente com harness ótimo
bate um modelo ótimo com harness ruim.

O espaço de design é real e ainda está aberto.

---

## 3. Os oito temas de arquitetura

São os eixos de decisão de qualquer harness. Este documento usa essa taxonomia para avaliar
o ObsidianKan na seção 6.

### a) Gerenciamento de contexto

**O tema central.** A janela de contexto é finita e, pior, **degrada antes de encher** —
fenômeno conhecido como *context rot*. Um modelo com a janela em 70% raciocina pior que o
mesmo modelo em 20%, mesmo com espaço sobrando.

Problemas clássicos:

- Ler um arquivo de 3.000 linhas uma vez e ele fica no contexto **para sempre**
- Tarefa longa enche a janela e o agente esquece as próprias instruções iniciais
- Cada schema de ferramenta ocupa espaço nobre, mesmo sem nunca ser usada

Táticas:

| Tática | O que faz |
|---|---|
| **Compactação** | resume mensagens antigas ao se aproximar do limite (gatilhos comuns: 60% e 80%) |
| **Offloading** | resultado grande vai para o disco, só o caminho fica no contexto |
| **Progressive disclosure** | carrega schema/skill sob demanda em vez de tudo no início |
| **Filesystem como contexto** | *"a estrutura de pastas e arquivos de um agente é uma forma de context engineering"* (Anthropic) |

### b) Memória e estado

**Contexto é efêmero. Memória é durável.** Confundir os dois é o erro mais comum.

Memória bem feita tem camadas:

1. **Fatos curados** — um `MEMORY.md`. Pequeno, denso, sempre no contexto.
2. **Histórico buscável** — índice (SQLite/FTS/embeddings) sobre sessões passadas. Não entra no
   contexto; é consultado sob demanda.
3. **Backends externos** — modelagem de usuário ao longo do tempo.

Perguntas de design que todo projeto precisa responder:

- **Quem escreve a memória?** O agente sozinho (arrisca poluir) ou o humano curando (não escala)?
- **O que merece ser lembrado?** Memória demais é indistinguível de memória nenhuma — vira ruído.
- **Como é recuperada?** Sempre presente ou buscada quando relevante?

### c) Ferramentas

Duas regras contraintuitivas:

**Dez ferramentas focadas batem cinquenta sobrepostas.** Não é sobre capacidade, é sobre o modelo
conseguir *raciocinar* sobre o conjunto.

**Ferramenta custa contexto mesmo sem ser chamada.** O schema está lá, competindo por atenção.

Decisão de granularidade:

```
bash("systemctl restart jellyfin")   ← genérica, poderosa, perigosa
reiniciar_jellyfin()                 ← específica, segura, previsível
```

**O MCP entra aqui.** É um protocolo que desacopla *a ferramenta* do *harness*. Sem MCP, uma
ferramenta só funciona no harness para o qual foi escrita. Com MCP, funciona em todos.

### d) Verificação

**O tema mais negligenciado — e o que separa demo de sistema que funciona.**

O loop é `coletar → agir → **verificar** → repetir`. Quase todo mundo implementa os três primeiros.

Três tipos de feedback:

- **Baseado em regra** — linter, type checker, teste, exit code. Barato, determinístico, o melhor
  quando aplicável.
- **Visual** — screenshot para tarefas de interface.
- **LLM-as-judge** — para critérios difusos. Caro, mas às vezes o único caminho.

Regra que importa: **separe o gerador do avaliador.** Agentes superestimam sistematicamente o
próprio trabalho. Um segundo agente avaliando bate auto-avaliação, sempre.

### e) Orquestração e subagentes

Subagentes existem por um motivo frequentemente mal entendido: **não é paralelismo, é isolamento
de contexto.** O subagente recebe uma tarefa suja, queima a própria janela nela, e devolve ao pai
**só a conclusão**. O contexto do orquestrador fica limpo.

Outros padrões de horizonte longo:

- **Planejador vs executor** — um agente decompõe, outro executa
- **Ralph loop** — intercepta a tentativa do modelo de encerrar e reinjeta o prompt original numa
  janela nova; cada iteração começa limpa e lê o estado da anterior pelo filesystem

### f) Permissão e isolamento

O agente executa comandos. Isso é o ponto dele e é o risco dele.

Mecanismos: gates de aprovação, allowlists de comando, sandbox (Docker, namespaces, capabilities
removidas), escopo por agente, controle de egress de rede.

O que torna isso não-paranoia: **prompt injection**. Uma mensagem, o conteúdo de uma página web,
o corpo de um card — qualquer texto que entra no contexto pode conter instrução. O agente não
distingue nativamente "dado" de "ordem".

**Defaults são arquitetura.** O OpenClaw deixa sandbox desligado por padrão e acumulou CVEs
graves; o Hermes liga aprovação por padrão.

### g) A superfície (gateway)

Por onde se fala com ele: CLI, chat, cron, webhook, voz. Parece periférico e não é — é o eixo que
separa as arquiteturas:

- **Gateway-cêntrico** (OpenClaw): o centro é o roteador de sessões entre canais e pessoas
- **Loop-cêntrico** (Hermes): o centro é o ciclo "do, learn, improve"
- **Runtime-cêntrico** (PicoClaw): o centro é o pipeline enxuto de execução

### h) Observabilidade

Log, trace, métrica de custo. Heurística: **sucesso silencioso, falha verbosa e acionável.**

### Décimo tema: supervisão e resiliência

O nono tema (interruptibilidade) veio do PicoClaw. O décimo não vem de nenhum dos três harnesses
pesquisados, porque nenhum resolve bem: **o que acontece quando o harness em si falha.**

Cota esgotada no meio de um processamento longo, processo morto, worker desconectado, sessão
expirada. Um harness sem supervisão trata isso como fim; um harness supervisionado trata como
pausa. Ver [§12](#12-a-camada-de-supervisão).

### Bônus: o princípio do ratchet

Não é arquitetura, é processo — mas é o que faz um harness melhorar em vez de apodrecer:

> **Todo erro do agente vira regra permanente. E toda regra precisa rastrear até uma falha real
> documentada — nunca uma hipotética.**

Corolário prático: mantenha o arquivo de instruções abaixo de ~60 linhas. Cada regra compete por
atenção. Um arquivo de 400 linhas de boas intenções performa pior que 40 linhas de cicatrizes reais.

### O fio que costura tudo

Relendo os oito temas, quase todos são a mesma coisa vista de ângulos diferentes:

> **Contexto é o recurso escasso. Arquitetura de harness é economia de contexto.**

- Compactação = comprimir o que já gastou
- Offloading = mover para fora
- Subagente = gastar o de outro
- Progressive disclosure = adiar o gasto
- Design de ferramenta = gastar menos por ferramenta
- Memória = não precisar gastar de novo amanhã
- Verificação = não desperdiçar gasto num caminho errado

---

## 4. Harnesses de referência pesquisados

| | **OpenClaw** | **Hermes Agent** | **PicoClaw** |
|---|---|---|---|
| Mantenedor | OpenClaw Foundation (non-profit) | Nous Research | Sipeed (hardware) |
| Licença | MIT | open source | open source |
| Estrelas | ~390 mil | — | ~30 mil |
| Commits | **97.542** | — | **2.584** |
| Stack | TypeScript (+ crates Rust) | Python + Node | Go (binário estático) |
| Centro de gravidade | Gateway / control plane | Loop "do, learn, improve" | Runtime / pipeline |
| Natureza | **plataforma** | **agente** | **runtime** |

### O que cada um contribui

**PicoClaw — a planta.** É o único pequeno o suficiente para ler inteiro. O loop está organizado
em quatro arquivos, cada um exportando uma função que recebe e devolve o estado do turno:

```
pipeline_setup.go     → monta prompt, carrega histórico, resolve modelo, monta hooks
pipeline_llm.go       → chama provider com streaming, parseia tool calls
pipeline_execute.go   → executa ferramentas, aplica approval gates, registra
pipeline_finalize.go  → persiste sessão, emite eventos, envia mensagens
```

Padrões transferíveis: persistência JSONL append-only, isolamento de processo por servidor MCP,
filas limitadas em todo lugar, EventBus read-only com poucos hooks síncronos, roteamento
*cheap-first* (classificador pontua o pedido e manda o simples para modelo barato), e `membench`
no CI para impedir regressão de memória.

Também introduz um nono tema: **interruptibilidade**. Fila FIFO de *steering* por sessão, consultada
em quatro checkpoints durante o turno. Ferramentas puladas recebem resultado explícito
`"Skipped due to queued user message"` — o modelo **sabe** que foi interrompido, em vez de achar
que a ferramenta falhou.

Limitação deliberada: memória de **50 mensagens**, sem recall semântico. É o preço de caber em 10MB.

**OpenClaw — o catálogo de memória.** Grande demais para ler (97k commits), mas a arquitetura de
memória é a melhor pesquisada:

- `USER.md` — perfil e preferências estáveis
- `MEMORY.md` — fatos duráveis, **o único injetado no bootstrap**
- `memory/YYYY-MM-DD.md` — camada de trabalho, indexada mas não injetada
- `DREAMS.md` — consolidações para revisão humana

Markdown é a verdade; SQLite é índice derivado (`{agentId}.sqlite` com embeddings e chunks).
Busca híbrida **como união, não interseção**: 70% semântico / 30% keyword — *"se um chunk pontua
alto em similaridade vetorial mas não contém a palavra-chave, ele entra mesmo assim."*

**O pre-compaction memory flush** é a melhor ideia dos três projetos: antes da compactação resumir
a conversa, dispara um turno agêntico silencioso pedindo ao modelo que escreva no disco o que
importa. Roda sobre uma **cópia privada da conversa**, responde `NO_REPLY` se não houver nada, e
um contador impede flush duplicado no mesmo ciclo.

> Compactação sem flush é **perda silenciosa de informação**. O flush transforma compactação de
> descarte em arquivamento.

Módulos relevantes para consulta cirúrgica: `src/memory/hybrid.ts`, `src/memory/manager.ts`,
`src/auto-reply/reply/memory-flush.ts`, `src/memory/embeddings.ts`,
`src/agents/tools/memory-tool.ts`.

**Hermes Agent — o loop que aprende.** Perfis independentes com identidade e `memory_store.db`
próprios, `MEMORY.md` + `USER.md`, SQLite FTS5, oito backends de memória externos, `Tool Search`
(esconde schemas de MCP até serem necessários — progressive disclosure), Bot Mode, A2A, sete
backends de execução. Defaults conservadores: *smart approval mode* ligado por padrão.

### Convergência

Três projetos independentes chegaram em **"markdown como verdade + banco como índice derivado"**.
Convergência assim é a evidência mais forte que existe de que o padrão está certo.

---

### Fichas técnicas detalhadas

Cada harness tem um documento próprio em `docs/harness/`, com arquitetura, ferramentas,
limitações e referências técnicas:

| Documento | Papel na pesquisa |
|---|---|
| [`docs/harness/PICOCLAW.md`](docs/harness/PICOCLAW.md) | **a planta** — pipeline de 4 estágios, o único legível por inteiro |
| [`docs/harness/OPENCLAW.md`](docs/harness/OPENCLAW.md) | **o catálogo de memória** — layout de 4 arquivos, busca híbrida, pre-compaction flush |
| [`docs/harness/HERMES.md`](docs/harness/HERMES.md) | **o loop que aprende** — memória em 3 camadas, skills auto-criadas, economia de prompt caching |
| [`docs/harness/CLAUDE_AGENT_SDK.md`](docs/harness/CLAUDE_AGENT_SDK.md) | **o miolo** — catálogo completo de hooks e o mapeamento nos buracos do projeto |

---

## 5. O que o ObsidianKan já acertou

Esta é a seção mais importante do documento, porque ela é o argumento contra a reescrita.

| Padrão | Onde aparece no mercado | Onde já está no ObsidianKan |
|---|---|---|
| Markdown como verdade, banco como índice derivado | OpenClaw, Hermes, PicoClaw | `kanban-data/<projeto>/*.md` + `better-sqlite3`, reconciliação por sha256 (`startup/reconcile.ts`) |
| Escrita atômica `tmp→rename` | PicoClaw (crash-safe) | `packages/server/src/writer/atomic.ts` |
| Log append-only | PicoClaw JSONL, OpenClaw daily logs | `.kanban/audit.ndjson` (`packages/server/src/audit/`) |
| Não reinventar o loop de tool | conclusão sobre o Agent SDK | comentário literal no código: *"não reinventamos um loop de tool aqui — o harness é melhor nisso (gestão de contexto, cache, ferramentas maduras)"* |
| Reaproveitar assinatura em vez de API key | rota Claude CLI do OpenClaw | `planning/claude-runner.ts` **remove `ANTHROPIC_API_KEY`** do env do subprocesso de propósito |
| Workflow determinístico + LLM só onde há julgamento | paper *Building Effective Agents* (Anthropic) | o paper é **citado** no topo de `scripts/sprint-workflow.ts` |
| Limites explícitos no loop | SubTurn caps do PicoClaw | teto de 50 rodadas, `DEV_DRAIN_LIMIT=3` |
| Gerador ≠ avaliador | princípio de verificação | dev agent executa, **PM agent tria** (`triageReviewLLM`) |
| Ralph loop (janela limpa, estado no FS) | padrão de horizonte longo | dev harness **stateless por rodada**; memória de progresso vive no board, não em contexto acumulado |
| Contrato de tipos normativo | — | `packages/shared/src/index.ts`, 1.123 linhas comentadas, declarado fonte normativa |
| Progressive disclosure de ferramentas | `Tool Search` do Hermes | `pmTriageTools()` expõe subconjunto escopado de 6 tools na triagem |
| Recuperação de dado corrompido | — | `extractBodyRaw` em `cards/serialize.ts` — recupera o texto humano mesmo perdendo o frontmatter |

Doze padrões. Nenhum copiado — todos derivados independentemente.

### Números do projeto

- Monorepo pnpm, Node ≥22, TypeScript 5.6.3 com `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`
- **67 tools MCP** (`@modelcontextprotocol/sdk ^1.29.0`)
- `.ts`: 176 arquivos, 31.862 linhas · `.tsx`: 60 arquivos, 10.781 linhas
- Server `src/`: 14.425 linhas · Web `src/`: 10.166 linhas · Shared: 1.341 linhas
- **61 arquivos de teste** (~14.300 linhas) em Vitest 4.1.9
- 191 commits, mai–ago/2026, com auditoria continuando em setembro
- Uso real comprovado: incidente de produção documentado no `CLAUDE.md`

---

## 6. Crítica tema a tema

| Tema | Estado | Nota |
|---|---|---|
| **a) Contexto** | delegado ao `--resume` do CLI; dev stateless por rodada | 🟡 funciona, mas o projeto está **fora** do harness e sem hooks |
| **b) Memória** | **não existe** | 🔴 o buraco estrutural |
| **c) Ferramentas** | 67 tools no catálogo; triagem já usa subconjunto de 6 | 🟡 67 é muito; o padrão certo já existe no próprio código |
| **d) Verificação** | fase inferida por parsing de emoji; triagem lê o auto-relato | 🔴 sem gate objetivo |
| **e) Orquestração** | workflow + LLM, limites explícitos, gerador≠avaliador | 🟢 bom — falta persistir estado do runner |
| **f) Permissão/isolamento** | RBAC não aplicado no serviço; `shell:true`; `acceptEdits` no repo real | 🔴 o que torna o projeto incompartilhável |
| **g) Superfície** | HTTP + stdio + SPA React com SSE/polling | 🟢 |
| **h) Observabilidade** | `token_log`, ingestão incremental de `~/.claude/projects/**/*.jsonl` com offset de bytes, audit NDJSON, rotas de métricas | 🟢 acima da média |
| **Ratchet** | `CLAUDE.md` documenta incidente real | 🟡 existe, mas é manual e não realimenta o prompt do dev |

---

## 7. Os três buracos críticos

### 🔴 7.1 Memória — nada acumula entre sprints

**Diagnóstico.** O board é memória de **estado**, não de **conhecimento**. O dev agent comete no
sprint 5 o mesmo erro que cometeu no sprint 1, porque nada sobrevive à rodada. A seção `# Agent Log`
no corpo do card é uma proto-memória, mas é por card, nunca destilada, nunca buscável semanticamente.

**Por que é o maior buraco.** É a diferença entre uma ferramenta que executa tarefas e um sistema
que melhora com o uso. Todos os harnesses de referência resolveram isso; o ObsidianKan não.

**Por que é barato de resolver aqui.** O substrato perfeito já existe: vault de markdown +
índice SQLite + watcher + escrita atômica + reconciliação. A arquitetura de memória do OpenClaw
cai em cima disso quase sem atrito:

```
.kanban/memory/
├── MEMORY.md            ← fatos duráveis, injetado no bootstrap do dev prompt
├── PROJECT.md           ← por projeto: convenções, stack, armadilhas conhecidas
├── 2026-09-20.md        ← log diário, indexado mas não injetado
└── (índice na SQLite existente, tabela nova)
```

**Destilação.** O que o PM aprende na triagem sobe para o `PROJECT.md`. Isso é o **ratchet
automatizado**: cada erro do dev vira regra permanente, rastreável a uma falha real — exatamente
o princípio da seção 3.

**Regra de higiene.** `MEMORY.md` e `PROJECT.md` abaixo de ~60 linhas cada. Detalhe vai para o
log diário, indexado mas não injetado.

---

### 🔴 7.2 Verificação — o sistema confia no auto-relato

**Diagnóstico.** O PM tria lendo o `# Agent Log`. Ou seja: **avalia o que o agente disse que fez,
não o que ele fez.** E agentes superestimam sistematicamente o próprio trabalho — esse é o achado
que sustenta todo o tema de verificação.

A separação gerador/avaliador está correta (dev executa, PM tria). O que falta é o **feedback
barato e determinístico** na frente dela.

**A regra que falta:**

> Um card não pode entrar em `review` sem que `tsc --noEmit` e os testes passem no `target_repo`.

A peça já existe: `kanban_start_job`. Falta torná-la um **gate**, não uma conveniência.
Rules-based feedback é o tipo mais barato e mais confiável que existe.

**Contrato implícito.** A fase do workflow é inferida por parsing de emojis (`▶`/`◀`) no log —
a própria vistoria de 05/09 classificou como *"contrato implícito sem teste"*. Precisa virar
evento estruturado. Idem a detecção de rate limit, hoje feita por regex na saída (`RATE_LIMIT_RE`).

**A ironia de fechamento.** O projeto **não tem CI**. Mais de 40 mil linhas de TypeScript, 61
arquivos de teste, nenhum gate automático — nem ESLint, nem Prettier, apenas `tsc --noEmit`
manual. Um sistema cuja tese é "agentes implementam código verificado" que não verifica a si mesmo.
O relatório de cobertura em `coverage/` é de 2026-06-16, enquanto o código foi modificado até
2026-08-04.

---

### 🔴 7.3 Permissão — o que impede compartilhar o projeto

**A pilha de riscos compõe de um jeito específico:**

1. Corpo de card é markdown que o agente **lê** → superfície de *prompt injection*
2. Dev agent roda com `--permission-mode acceptEdits` **dentro do `target_repo` real**
3. `kanban_start_job` faz `spawn(command, { shell: true })` **sem allowlist nem sandbox**
   (`packages/server/src/services/job-runner.ts`)
4. RBAC não é aplicado em `CallTool` — o catálogo filtra apenas `tools/list`, mas qualquer token
   válido executa qualquer tool (achado crítico **C1** da vistoria; *"zero teste negativo de RBAC"*)
5. 10 rotas GET protegidas apenas por checagem de IP privado (RFC1918 inteira), não por token
6. Editor de skills (`services/skills.ts`, ainda não commitado na data da vistoria) permite editar
   `spawn-dev.sh` e `dev.mcp.json` pelo browser — descrito na própria vistoria como *"RCE por design"*
   se o servidor estiver exposto com `HOST=0.0.0.0`

Isso é exatamente o que a documentação do OpenClaw adverte — *"trate mensagens de entrada como
input não confiável"* e *"ferramentas rodam no host a menos que sandboxing esteja configurado"* —
e eles acumularam CVEs graves por vizinhança disso.

**Avaliação honesta de risco.** Na máquina do autor, contra os próprios repos, com o servidor em
loopback: risco prático hoje é baixo. Mas é precisamente o que trava o projeto em "ferramenta
pessoal" permanentemente.

**Duas correções com boa relação custo/benefício:**

- **Worktree git isolado por card** — é o que o Vibe Kanban faz. O agente nunca toca a árvore
  principal; o humano revisa o diff e faz o merge. Reduz o *blast radius* sem restringir o agente.
- **Allowlist em `start_job`** — melhor ainda via `PreToolUse` do Agent SDK (seção 8).

**Correção de documentação relacionada.** O `CLAUDE.md` chama os tokens de "JWT", mas
`packages/server/src/auth/tokens.ts` implementa tokens opacos
(`randomBytes(32).toString('base64url')` + hash SHA-256 armazenado). Divergência doc↔código.

---

## 8. A troca central: subprocess → Agent SDK

Esta é a decisão arquitetural mais consequente do roadmap — e é mais barata do que parece, porque
a peça já está isolada em dois arquivos: `packages/server/src/planning/claude-runner.ts` e
`packages/server/scripts/sprint-workflow.ts`.

### Situação atual

Há **dois caminhos de credencial distintos**, documentados no próprio código:

| Caminho | Mecanismo | Credencial |
|---|---|---|
| Wizard de planejamento | `spawn('claude', ['-p', ...])`, continuidade via `--resume <session_id>` | **sessão logada** (remove `ANTHROPIC_API_KEY`) |
| Dev agent | `spawn('claude', [...])` com `--mcp-config`, `--permission-mode acceptEdits` | **sessão logada** |
| Triagem PM | `client.beta.messages.toolRunner()` com `betaZodTool` | **API key** (pago) |

Spawnar o CLI dá o harness maduro e o uso da assinatura — mas deixa o projeto **do lado de fora**,
sem hook nenhum.

### O que o Agent SDK destrava

O uso do Agent SDK também consome o limite da assinatura, então a economia é preservada.
E os hooks disponíveis mapeiam **um a um** nos buracos identificados:

| Buraco | Hook | Pode bloquear? |
|---|---|---|
| Memória não persiste na compactação | `PreCompact` — caso de uso documentado: *"arquivar o transcript completo antes de resumir"* | **Sim** |
| Log do resumo gerado | `PostCompact` | não |
| `MEMORY.md`/`PROJECT.md` não chegam ao agente | `UserPromptSubmit` — injeção de contexto | sim |
| `shell:true` sem allowlist | `PreToolUse` → `permissionDecision: allow/deny/ask/defer` | **Sim** |
| Auditar/registrar resultado de tool | `PostToolUse` → `additionalContext`, `updatedToolOutput` | sim |
| Fase inferida por emoji | `SubagentStart` / `SubagentStop` — eventos estruturados | — |
| Estado do runner só em memória | `Stop` / `SessionEnd` — persiste antes de sair | — |

**Cinco problemas, um refactor.**

Há ainda um gancho para *interruptibilidade* (o nono tema, do PicoClaw):
`permissionDecision: "defer"` encerra a query para retomada posterior.

### Ganho de custo

Consolidar a triagem no mesmo caminho elimina o uso de API key paga, movendo todo o consumo para
a assinatura.

### O que se perde

Controle fino do interior do loop. Hoje o CLI gerencia contexto e cache de forma madura e opaca;
com o SDK, parte disso continua automática, mas passa a ser observável e interceptável via hooks.
Na prática é um ganho líquido para este caso de uso.

### Padrão recomendado: o miolo trocável

Estruturar o runner como estágios com estado explícito de turno (padrão PicoClaw):

```
setup     → carrega sessão, monta contexto, injeta memória, resolve modelo
  ↓
[ run ]   → Agent SDK  (loop, compactação, subagentes, MCP)   ← peça trocável
  ↓
finalize  → persiste estado, emite evento, atualiza board
```

Com `TurnState → TurnState`, o estágio do meio vira implementação trocável. Se um dia for
necessário assumir o loop por completo, `setup`, `finalize`, canais, persistência e memória
permanecem intocados.

---

## 9. Posicionamento de mercado

### Prior art direto

**Vibe Kanban** — passou de **24 mil estrelas** em 2026. Implementa MCP de forma que outros
agentes criam tasks, movem cards e leem o board: *"o kanban board como API para IA"*. Cada card é
uma task de código, e o agente executa **em worktree git isolado**.

**CodeAgentSwarm** — board de 4 colunas onde os agentes leem e atualizam o próprio board: escrevem
plano antes de começar, deixam resumo de implementação ao terminar, e **criam subtasks quando a
tarefa se revela maior que o previsto**.

**Padrão geral emergente:** coluna = cadeia ordenada de workflows; card = job agêntico persistente
carregando contexto, comentários, anexos e outputs; humanos dirigem o loop por threads de
comentário e review.

### Diferenciação do ObsidianKan

O projeto precisa de uma resposta explícita para "por que não Vibe Kanban?". Ela existe, só não
está escrita:

> O Vibe Kanban trata o board como fila de tasks de código. O ObsidianKan trata o **vault como
> sistema operacional do projeto** — planejamento, metas, épicos, sprints e execução no mesmo
> substrato que o humano edita à mão, sem lock-in e sem servidor de terceiros.

Acrescente: RBAC multi-papel (manager/pm/dev), workflow autônomo de sprint com triagem por PM, e
wizard de planejamento que vai de visão a cards. **Isso deve ir para o README.**

### Metodologia: Spec-Driven Development

A segunda metade da visão do projeto — *"as LLM contribuem na construção do projeto, definindo
etapas até a criação das tasks"* — tem nome, virou disciplina e tem toolkit aberto do GitHub
(**Spec Kit**, agent-agnostic, 30+ agentes, v1.0.1 em ago/2026):

```
Specify → Plan → Tasks → Implement → Converge
```

O `tasks.md` gerado pelo Spec Kit contém:

- quebra organizada **por user story**
- **ordenação por dependência**
- marcadores `[P]` de execução paralela
- **caminho de arquivo exato** por task
- **checkpoints de validação entre fases**

Prática central: *"sempre rode `analyze` antes de implementar — pega violações e lacunas lógicas
que causariam falha em runtime."* Isso é o tema de verificação aplicado à camada de planejamento.

**Campos a considerar no schema do Card.** O `Card` já tem `blocked_by` (dependências). Faltam:

| Campo | Para quê |
|---|---|
| `parallel_group` / `[P]` | sinalizar cards que podem rodar em paralelo na mesma rodada |
| `expected_files: string[]` | caminhos que a task deve tocar — vira verificação objetiva |
| `acceptance: string` | critério de checkpoint, legível por máquina quando possível |

Isso transforma card em **contrato executável** e alimenta direto o gate de verificação de 7.2.

---

## 10. Evoluir vs reescrever

**Recomendação: evoluir.** As razões, explicitadas:

1. **Reescrever seria para chegar onde já se está.** As doze convergências da seção 5 não são
   acidentes — são as decisões certas. Refazer do zero arrisca perdê-las.
2. **As lacunas são aditivas, não estruturais.** Memória, gates de verificação e enforcement de
   permissão se somam ao sistema. Nenhuma exige alterar o modelo de dados, o layout do vault, o
   contrato de tipos ou a SPA.
3. **O capital acumulado é real.** 40k+ linhas, 61 arquivos de teste, uso em produção com
   incidente documentado, documentação organizada por público. Isso é conhecimento pago com dor.
4. **A única peça que pareceria exigir reescrita já é trocável.** A integração LLM está isolada em
   dois arquivos, e o padrão `TurnState → TurnState` a torna substituível sem tocar no resto.

### O que merece limpeza (higiene, não arquitetura)

Levantado pela vistoria de 05/09 e confirmado na exploração:

- `planning/` vs `sprint-planning/` com ~50% de código duplicado (6 pares de arquivos homônimos)
- ~35 scripts `smoke-batch*.mjs` mortos em `packages/server/scripts/`
- `package-lock.json` residual convivendo com `pnpm-lock.yaml` (projeto usa pnpm)
- `coverage/` desatualizado (junho, código de agosto)
- Docs desatualizados: `docs/for-developers/testing.md`, `docs/for-agents/agent-runbook.md`
  (paths de antes do monorepo), `docs/reference/design/*` (autodeclaram "source of truth" mas
  divergem do código)
- `CLAUDE.md` diz "JWT" onde o código usa token opaco
- Working tree com 3 frentes não relacionadas misturadas — separar em commits distintos
- Preço de modelo hardcoded em 3 lugares (script, shared, terminal-usage) — consolidar

---

## 11. Arquitetura de deployment — Pi + workers

> Decisão tomada em 2026-09-20. Contexto de hardware: um **Raspberry Pi 5** disponível para
> ficar ligado 24/7 (~8W) e uma **workstation com RTX 3090** que é a base de trabalho e onde
> o código precisa rodar.

### 11.1 O problema

O sistema tem duas naturezas de trabalho com requisitos opostos:

| | Precisa estar sempre ligado | Precisa de CPU/GPU/disco | Blast radius aceitável na mesma caixa dos dados |
|---|:---:|:---:|:---:|
| Guardar dados, servir dashboard, agendar | ✅ | ❌ | ✅ |
| Compilar, testar, editar repositório | ❌ | ✅ | ❌ |

Hoje o ObsidianKan trata as duas como uma coisa só: `planning/claude-runner.ts` roda **dentro do
processo do servidor**, e `scripts/sprint-workflow.ts` é orquestrador e executor no mesmo processo.
Isso não é problema enquanto tudo roda no notebook — vira problema no instante em que se tenta
separar.

### 11.2 Os dois planos

**Plano de controle e autoria — Raspberry Pi 5, 24/7**

- vault (`kanban-data/**/*.md`) — fonte de verdade
- SQLite (índice derivado) + reconciliação + watcher
- servidor MCP (HTTP) com as 67 tools
- dashboard / web UI
- **wizard de planejamento** (KAD: visão → PRD → domínio → arquitetura → roadmap → cards)
- **triagem PM** da coluna `review`
- orquestração de sprint: decide **o quê** e **quando**
- cron, fila de trabalho, registro de workers
- disparo de Wake-on-LAN

**Plano de execução — workstation (e futuros workers)**

- dev agent: `claude` CLI com acesso a ferramentas de arquivo e Bash
- builds, typecheck, suíte de testes
- `kanban_start_job`
- tudo que toca um `target_repo`

### 11.3 A linha divisória

O critério **não** é "quem chama LLM". É:

> **Toca `target_repo`? Vai para um worker. Não toca? Fica no Pi.**

| Trabalho | Chama LLM? | Toca repo? | Onde |
|---|:---:|:---:|---|
| Wizard de planejamento | sim | **não** — roda em cwd neutro (`.kanban/planning`) | **Pi** |
| Triagem PM (`triageReviewLLM`) | sim | não — só lê e move cards | **Pi** |
| Escrita e edição manual de card | não | não | **Pi** |
| Dev agent | sim | **sim** | **worker** |
| Job de build/teste | não | **sim** | **worker** |

Isso é viável porque o `claude-runner.ts` **já** executa em diretório neutro e nunca aponta para
um repositório real — decisão que já estava certa no código.

**Consequência:** o Pi precisa de um login do Claude Code para o wizard e a triagem. É um login
interativo por navegador, feito uma vez via SSH (abre-se a URL no desktop). Precisa de
monitoramento de expiração — ver §13.

### 11.4 O modelo de worker

Padrão de referência: os **nodes** do OpenClaw (conectam ao Gateway declarando `role: node` com
capabilities explícitas, com device pairing store) e os **backends de execução** do Hermes
(`local` / `docker` / `ssh` / sandbox — *"mesma ferramenta, blast radius diferente"*).
Ver [OPENCLAW.md](docs/harness/OPENCLAW.md) e [HERMES.md](docs/harness/HERMES.md).

#### Direção da conexão

> **O worker conecta para o Pi. O Pi nunca inicia conexão com o worker.**

Motivo: a workstation dorme, reinicia e troca de rede. Conexão de saída é o que torna runner de
CI, GitHub Actions self-hosted e Buildkite agent resilientes. A única exceção é o pacote
Wake-on-LAN (§11.5), que é UDP em broadcast, não conexão.

#### Registro de worker

```json
{
  "worker_id": "workstation-01",
  "capabilities": ["gpu:rtx3090", "cuda:12", "docker", "node:22", "python:3.12"],
  "repos": ["/home/<user>/Projects/PESSOAL", "/home/<user>/Projects/TRABALHO"],
  "max_concurrent": 2,
  "wake_mac": "XX:XX:XX:XX:XX:XX",
  "wake_timeout_s": 120
}
```

E o projeto declara o que exige:

```ts
export interface ProjectMeta {
  target_repo?: string
  requires_capabilities?: string[]   // novo
  // ...
}
```

Capability não é enfeite: a viabilidade de um executor depende do projeto. O monorepo TypeScript
do próprio ObsidianKan roda num Pi 5 com NVMe (lento, tolerável para trabalho noturno); um
projeto Rust, com Docker ou suíte pesada, não.

#### O que já existe no repositório

| Peça | Estado |
|---|---|
| Servidor MCP em HTTP | ✅ é o padrão |
| Token por papel (manager/pm/dev) | ✅ |
| `kanban_pick_next` / `kanban_claim_card` | ✅ **o protocolo de claim já existe** |
| Optimistic locking (`version`) | ✅ impede dois workers no mesmo card |
| `kanban_start_job` | ✅ |
| Audit log NDJSON | ✅ |

#### O que falta

1. **Separar orquestrador de executor** — o refactor habilitador
2. **Registro + heartbeat de worker**
3. **Estado do workflow persistido no Pi** — já é o item P0.4; o modelo de worker o torna
   obrigatório, porque o estado não pode mais viver na memória do executor

#### Transporte

A web UI já usa SSE/polling. Caminho mais curto que ainda é correto: worker assina SSE para
receber despacho + `POST` HTTP para reportar. WebSocket tipado (padrão OpenClaw) é o upgrade
natural quando for preciso controle bidirecional — cancelamento e steering.

Rede: **Tailscale** entre Pi e workers. Sem porta exposta.

> ⚠️ **O item P0.2 (aplicar RBAC em `CallTool` e nas rotas REST) deixa de ser negociável.**
> Enquanto tudo rodava em loopback, "qualquer token válido executa qualquer tool" era um risco
> teórico. Com um token `dev` trafegando pela rede até outra máquina, não é mais.

### 11.5 Wake-on-LAN

O Pi passa a ser o botão de liga do pool de execução.

#### Mecânica

Um **magic packet** — UDP em broadcast na porta 9, contendo `FF FF FF FF FF FF` seguido do MAC
repetido 16 vezes. A placa de rede escuta com energia de standby e aciona o power. Pi e
workstation na mesma LAN, então o broadcast alcança sem roteamento.

#### ⚠️ Pré-requisito: cabo de rede

**Wake-on-LAN por Wi-Fi não é confiável.** WoWLAN depende de chipset, driver e roteador
cooperando, e no Linux raramente funciona a partir de suspensão. Na prática, WoL é ethernet.

*Estado verificado em 2026-09-20: a workstation está conectada por Wi-Fi (`wlo1`); a interface
ethernet (`enp3s0`) existe mas está sem cabo (`NO-CARRIER`). Passar o cabo é o pré-requisito
número um desta feature.*

#### ⚠️ Suspender, não desligar

| Estado | WoL funciona | Útil para automação |
|---|:---:|---|
| **S3 (suspend)** | ✅ | ✅ disco já destravado, retorno em segundos |
| S4 (hibernate) | ✅ | 🟡 mais lento, pode pedir senha |
| S5 (desligada) | ✅ com BIOS adequado | ❌ trava na passphrase se houver disco criptografado |

Alvo: **S3**. A economia continua válida — uma workstation com GPU dedicada consome ~70–100W
ociosa contra ~3–5W suspensa.

#### Configuração

**BIOS/UEFI:** habilitar *Wake on LAN* / *Power On by PCI-E*; **desabilitar *ErP Ready* / *EuP***
— essa opção corta a energia de standby da placa de rede e mata o WoL silenciosamente.

**Na workstation:**

```bash
sudo ethtool <iface> | grep -i wake     # "Supports Wake-on:" precisa conter 'g'
sudo ethtool -s <iface> wol g           # não persiste no reboot
```

Persistir via NetworkManager:

```bash
nmcli connection modify <conexao> 802-3-ethernet.wake-on-lan magic
```

Ou via unit systemd `oneshot` com `After=network-online.target`.

**No Pi:**

```bash
sudo apt install wakeonlan
wakeonlan <MAC-do-worker>
```

#### Fluxo integrado

```
1. Sprint ativa, card pronto para despacho
2. Pi: nenhum worker online com a capability exigida
3. Pi consulta o registro → envia magic packet
4. Pi aguarda registro do worker (timeout configurável, ex. 120s)
5. Despacha o card
6. Worker mantém inibidor de sleep enquanto houver card reivindicado
7. Fila vazia + ociosidade → libera o inibidor → a máquina suspende sozinha
```

#### Dois detalhes operacionais

**Inibidor de sleep.** A máquina não pode suspender no meio de um build. Usar `systemd-inhibit`
envolvendo o job, ou o worker segura um lock enquanto tem trabalho. Ao liberar, o timeout normal
de ociosidade cuida do resto — mais robusto que o worker mandar suspender explicitamente.

**Falha de wake não pode ser silenciosa.** Timeout estourado → o card volta para a fila e o
evento entra no audit log. O pior cenário possível é a sprint "rodando" de madrugada com nenhum
executor acordado e nada registrado.

#### Fallback

Se o WoL não cooperar: **NanoKVM** ou **PiKVM** dão controle remoto real, incluindo o botão de
power pelo header da placa-mãe. Tomada inteligente **não** serve — é corte bruto de energia e,
com disco criptografado, recai na passphrase.

### 11.6 Problemas que esta arquitetura dissolve

| Problema levantado | Resolução |
|---|---|
| Login do Claude num Pi headless para o **dev agent** | O dev agent roda no worker, onde o login já existe e é usado diariamente |
| `target_repo` viraria um clone no Pi | Os repositórios permanecem na workstation |
| `terminal_usage` lendo dois hosts | O CLI de execução roda só no worker; ele varre o próprio `~/.claude/projects` e reporta junto com o resultado do job |
| Sprint órfã após reinício | Heartbeat perdido → o Pi devolve os cards reivindicados para a fila. É a correção do P0.4 generalizada |
| Servidor que só existe quando alguém lembra de subir | Watcher, cron e orquestração viram infraestrutura em vez de comando manual |

### 11.7 Ordem de dependência

```
P0.2 RBAC aplicado ──────────────┐
                                 ├──► protocolo de worker ──► Wake-on-LAN
P0.4 estado persistido ──────────┤
                                 │
separar orquestrador/executor ───┘

P1.7 gate de verificação ──┐
                           ├──► direito de rodar sem supervisão
P2.9 worktree isolado ─────┘
```

> **Regra:** o gate de verificação e o worktree isolado são o que **compra o direito** de
> executar sem supervisão. Antes deles, execução autônoma de madrugada com
> `--permission-mode acceptEdits` é passivo, não ativo.

### 11.8 Bônus: embeddings locais na GPU

A camada de memória do P1 (§7.1) precisa de embeddings para busca híbrida. O OpenClaw suporta
providers locais exatamente para isso.

Com uma GPU dedicada ociosa fora do horário de trabalho, os embeddings do `memory_search` podem
rodar localmente: **de graça, privados e rápidos**, sem enviar o conteúdo do vault para API
nenhuma.

Fecha um ciclo da pesquisa: rodar o **LLM principal** local é má ideia — o raciocínio vai para o
Claude na assinatura; rodar o trabalho **mecânico e volumoso** local é ótima ideia.

---

## 12. A camada de supervisão

> Camada acima do harness, responsável por assumir quando o harness cai ou quando a cota do dia
> acaba. É o décimo tema de arquitetura (§3) e o único que nenhum dos harnesses pesquisados
> resolve bem.

### 12.1 O problema

Cenário concreto e já vivido neste projeto (incidente de sprint presa documentado no `CLAUDE.md`):

```
03:12  dev agent trabalhando no card-7f2a
03:47  API responde: rate limit — "tokens reset: 4AM"
03:47  o processo morre, ou fica em retry cego, ou simplesmente para
09:00  você descobre a sprint parada, sem saber em que ponto
```

O que deveria acontecer:

```
03:47  supervisor detecta: cota esgotada, reset conhecido às 04:00
03:47  persiste o estado; devolve o card à fila; libera o worker para suspender
03:47  agenda retomada para 04:05 (reset + margem)
04:05  acorda o worker (Wake-on-LAN, §11.5), redespacha o card
04:05  o agente que retoma recebe o contexto: "você foi interrompido às 03:47
       por esgotamento de cota; aqui está o que já tinha sido feito"
```

### 12.2 Onde essa camada mora

**Fora do processo que ela supervisiona.** Um supervisor dentro do `sprint-workflow.ts` morre
junto com ele — o que é exatamente o modo de falha que ele deveria cobrir.

O lugar natural é o **Raspberry Pi**: sempre ligado, barato, já é o plano de controle e já guarda
o estado durável (§11.2). O supervisor é o trabalho que justifica o Pi melhor que qualquer outro.

```
Pi (sempre ligado)
├── orquestrador de sprint
├── SUPERVISOR              ← observa, classifica, decide, reagenda
│   ├── classificador determinístico
│   ├── interpretador LLM (só para o desconhecido)
│   ├── agendador de retomada
│   └── disparo de Wake-on-LAN
└── estado durável (NDJSON + SQLite)
         ↕
Worker — pode morrer, dormir, desconectar
```

### 12.3 ⚠️ A regra que define o desenho

> **O supervisor não pode depender daquilo que falhou.**

Se a cota do Claude acabou, o supervisor não pode ser o Claude. Parece óbvio, e é o erro mais
comum nesse tipo de camada: escrever o supervisor com o mesmo provider, mesma credencial e mesmo
caminho de rede do supervisionado. Quando o supervisionado cai, o supervisor cai junto e ninguém
percebe.

Consequências práticas:

- **Provider diferente** para o interpretador LLM
- **Processo diferente**, em **máquina diferente** (o Pi)
- **Credencial diferente** da usada pelos agentes
- O caminho crítico de recuperação **não deve exigir LLM nenhum** (ver §12.4)

### 12.4 Dois níveis: determinístico primeiro, LLM depois

Colocar um LLM como primeira linha de recuperação adiciona não-determinismo justamente onde ele
é menos tolerável. A divisão correta:

**Nível 1 — classificador determinístico (sem LLM)**

Cobre as falhas de forma conhecida. Barato, testável, rápido, funciona com a API fora do ar.
É o que trata o caso `"tokens reset: 4AM"`: parse da mensagem, extrai o horário, agenda, pronto.

**Nível 2 — interpretador LLM (só para o resíduo)**

Entra quando o nível 1 não reconhece a falha. Recebe a mensagem de erro, o estado do job e a
taxonomia conhecida, e emite uma **decisão estruturada**, não texto livre:

```json
{
  "classification": "quota_exhausted",
  "retryable": true,
  "resume_at": "2026-09-21T04:05:00-03:00",
  "release_worker": true,
  "human_notification": false,
  "reason": "mensagem indica reset de cota às 4AM; agendada retomada com 5min de margem",
  "confidence": 0.92
}
```

Saída estruturada com schema validado, e **um fallback determinístico se o LLM falhar ou devolver
algo inválido** — normalmente: backoff exponencial e escalada para humano.

> Cada falha que o nível 2 classifica bem e repetidamente **deve virar regra do nível 1**.
> É o princípio do ratchet (§3) aplicado à recuperação: o supervisor fica progressivamente mais
> determinístico com o tempo, não mais dependente de LLM.

### 12.5 Taxonomia de falhas

| Classe | Sinal | Ação | Nível |
|---|---|---|---|
| **Cota esgotada, reset conhecido** | mensagem com horário (`tokens reset: 4AM`) | dormir até reset + margem; liberar worker; reagendar | 1 |
| **Rate limit com `retry-after`** | header da API | backoff conforme o header | 1 (já existe) |
| **Rate limit sem horário** | `RateLimitError` sem dica | backoff exponencial com teto | 1 (já existe) |
| **Erro transitório de API** | 5xx, timeout de rede | retry com backoff | 1 |
| **Worker desconectado / dormiu** | heartbeat perdido | devolver card à fila; acordar; redespachar | 1 |
| **Processo morreu** | pidfile morto, sem heartbeat | retomar do estado durável | 1 |
| **Agente sem progresso** | orçamento de iteração esgotado, nenhum arquivo tocado | **não** repetir — escalar | 1 |
| **Sessão/credencial expirada** | erro de auth | **não é auto-recuperável** — notificar humano | 1 |
| **Desconhecido** | qualquer outra coisa | interpretar e decidir | **2** |

Distinguir **retryable** de **não retryable** é o ponto mais importante da tabela. Repetir
indefinidamente uma falha de autenticação ou um bug determinístico é o que queima cota e produz
a sprint presa às 3h.

### 12.6 Orçamento de recuperação

O supervisor também precisa de limites — senão ele vira o loop infinito que deveria prevenir.

| Limite | Sugestão |
|---|---|
| Tentativas de recuperação por card | 3 |
| Tentativas por sprint | 10 |
| Janela máxima de espera agendada | 12h (além disso, escala) |
| Recuperações consecutivas sem progresso | 2 → escala |

Ao estourar: parar, marcar o card, registrar no audit log e **notificar**. Falha silenciosa é
pior que falha ruidosa.

### 12.7 O contexto de retomada

O agente que retoma **precisa saber que foi interrompido**, e por quê. Sem isso ele reinterpreta
trabalho pela metade como trabalho errado, e desfaz o que já estava certo.

É o mesmo princípio do `"Skipped due to queued user message"` do PicoClaw (ver
[PICOCLAW.md §7](docs/harness/PICOCLAW.md)): o modelo deve saber que foi interrompido, em vez de
concluir que algo falhou.

Na prática, o evento é escrito em dois lugares:

- **`# Agent Log` do card** — narrativa local, visível no dashboard
- **log diário da memória** (§7.1) — para que o padrão seja detectável ao longo do tempo

E injetado no prompt de retomada:

```
Você foi interrompido em 2026-09-21 03:47 durante este card.
Motivo: cota de tokens esgotada (reset às 04:00).
Progresso registrado até a interrupção: <resumo do Agent Log>
Estado do repositório: <branch, arquivos modificados, testes>
Continue de onde parou. Não refaça trabalho já concluído.
```

### 12.8 O que já existe no repositório

| Peça | Estado |
|---|---|
| `RATE_LIMIT_RE` — detecção de rate limit por regex em `claude-runner.ts` | 🟡 existe, mas é regex sobre saída (contrato implícito) |
| Retry com backoff em `RateLimitError`, honrando `retry-after` | ✅ em `sprint-workflow.ts`, até `RATE_LIMIT_MAX_RETRIES` (padrão 10) |
| Watchdog em jobs de longa duração | ✅ |
| Teto de rodadas (50) e `DEV_DRAIN_LIMIT` | ✅ |
| Audit log NDJSON append-only | ✅ substrato pronto para o estado do supervisor |
| **Estado durável do runner** | ❌ **P0.4** — sem isso não há retomada possível |
| **Supervisor fora do processo** | ❌ |
| **Dormir até reset conhecido** | ❌ hoje só há backoff, que não entende "4AM" |
| **Contexto de retomada** | ❌ |

O retry existente cobre o caso curto (rate limit de minutos). Não cobre o caso longo (cota diária
esgotada às 3h com reset às 4h) — dez retries com backoff não atravessam uma hora, e mesmo que
atravessassem, seriam dez chamadas desperdiçadas.

### 12.9 Provider do supervisor

O nível 2 precisa de um LLM que **não** compartilhe o ponto de falha. Opções, em ordem de
preferência para este projeto:

| Opção | Prós | Contras |
|---|---|---|
| **Modelo local na RTX 3090** | grátis, privado, não tem cota para esgotar | indisponível quando a workstation dorme — que é justamente quando o supervisor age |
| **API barata de outro provider** | sempre disponível, independente | custo pequeno, mais uma credencial |
| Mesmo provider, credencial separada | simples | ❌ **não resolve** — cota esgotada afeta ambos |

Recomendação: **API barata de outro provider** como padrão do nível 2, porque o supervisor
precisa funcionar exatamente no momento em que a workstation está suspensa. A tarefa é minúscula
— ler uma mensagem de erro e emitir um JSON — então um modelo pequeno basta e o custo é
desprezível.

O modelo local na 3090 continua útil para o trabalho volumoso e não crítico: embeddings da
camada de memória (§11.8).

### 12.10 Composição com o resto da arquitetura

Esta camada não é isolada — ela costura o que já foi decidido:

| Depende de | Para quê |
|---|---|
| **P0.4** estado durável | sem estado persistido não existe retomada |
| **§11.4** heartbeat de worker | detectar worker morto ou adormecido |
| **§11.5** Wake-on-LAN | acordar a máquina no horário do reset |
| **§7.1** camada de memória | registrar o evento e alimentar o contexto de retomada |
| **§8** hooks do Agent SDK | `Stop` / `SessionEnd` para persistir, `PostToolUseFailure` para sinalizar |
| Audit log NDJSON | trilha append-only das decisões do supervisor |

---

## 13. Roadmap priorizado

### P0 — destrava o resto

| # | Item | Por quê |
|---|---|---|
| 1 | **CI**: `typecheck` + `vitest` no push | Sem isso, nenhuma mudança abaixo é verificável |
| 2 | **Aplicar RBAC** em `CallTool` e nas rotas REST + **testes negativos** | Achado crítico C1; hoje qualquer token válido executa qualquer tool. **Bloqueante para o modelo de worker (§11.4)** |
| 3 | **Allowlist** em `kanban_start_job` | Fecha a superfície de `shell: true` |
| 4 | **Persistir estado do `WorkflowRunner`** | Elimina sprint órfã em reinício; a infra NDJSON append-only já existe. **Obrigatório no modelo de worker** — o estado não pode viver na memória do executor |

### P1 — o salto de capacidade

| # | Item | Por quê |
|---|---|---|
| 5 | Migrar `claude-runner.ts` e o dev runner para o **Agent SDK** | Destrava todos os hooks (seção 8) e unifica credencial na assinatura |
| 6 | **`PreCompact` → memory flush**; **`UserPromptSubmit` → injetar `MEMORY.md`/`PROJECT.md`** | A camada de memória (7.1) |
| 7 | **Gate de verificação**: typecheck + testes verdes antes de `review` | O feedback determinístico que falta (7.2) |
| 8 | **Eventos estruturados** no lugar do parsing de emoji e do regex de rate limit | Elimina o contrato implícito |
| 9 | **Separar orquestrador de executor** (plano de controle vs plano de execução) | O refactor habilitador de todo o §11; hoje `claude-runner.ts` roda dentro do servidor |
| 10 | **Supervisor determinístico** (§12.4 nível 1): taxonomia de falhas, dormir-até-reset, retomada com contexto | Cobre a classe de incidente que já aconteceu — sprint presa de madrugada. Depende de P0.4 |

### P2 — escala e compartilhamento

| # | Item | Por quê |
|---|---|---|
| 11 | **Worktree isolado por card** | Reduz blast radius; padrão do Vibe Kanban. Junto com o item 7, **compra o direito de rodar sem supervisão** |
| 12 | **Escopo de tools por papel** (generalizar o que `pmTriageTools()` já faz) | 67 schemas competindo por atenção |
| 13 | **Campos do Spec Kit** no Card (`parallel_group`, `expected_files`, `acceptance`) | Card vira contrato executável |
| 14 | **Higiene** (lista da seção 10) | Reduz atrito para qualquer contribuidor, inclusive agentes |

### P3 — deployment distribuído (Pi + workers)

Trilha própria, detalhada em [§11](#11-arquitetura-de-deployment--pi--workers).
Depende de P0.2, P0.4 e do item 9.

| # | Item | Por quê |
|---|---|---|
| 15 | **Protocolo de worker**: registro, heartbeat, capabilities, despacho | Permite que o Pi guarde os dados e a workstation execute o código |
| 16 | **`requires_capabilities` no `ProjectMeta`** | A viabilidade do executor depende do projeto; roteamento por capability |
| 17 | **Heartbeat → devolver cards órfãos à fila** | Generaliza a correção do P0.4 para desconexão de worker |
| 18 | **Wake-on-LAN + inibidor de sleep** | Pi acorda a workstation sob demanda; ela suspende sozinha ao ficar ociosa. ⚠️ Exige cabo ethernet |
| 19 | **Supervisor acorda para retomar** (§12.6) | Junta o item 10 com o 18: reset de cota às 4h → magic packet → redespacho |
| 20 | **Interpretador LLM do supervisor** (§12.4 nível 2), em provider distinto | Trata o resíduo não classificável; cada acerto recorrente vira regra do nível 1 |
| 21 | **Login do Claude no Pi** (wizard de planejamento e triagem PM) | O Pi passa a executar LLM sem repo; precisa de sessão válida e monitorada |
| 22 | **`terminal_usage` ciente do host** | Com o CLI rodando no worker, a contabilidade precisa saber de onde lê |
| 23 | **Embeddings locais na GPU** para `memory_search` | Busca semântica gratuita e privada; aproveita hardware ocioso (§11.8) |

> ⚠️ **Este roadmap está incompleto.** Uma revisão posterior identificou sete lacunas que nenhuma
> seção deste documento cobria — entre elas a ausência de rollback no vault, de canal de
> notificação e de teste da camada de agente. Ver [LACUNAS.md](LACUNAS.md), que inclui proposta
> de reordenação.

### Sugestão de ponto de partida

**P0 itens 1 e 2 juntos.** CI primeiro, porque é o que transforma todas as outras mudanças em algo
verificável; RBAC junto, porque é o buraco mais grave e o mais fácil de fechar com teste negativo.

Alternativa, se a prioridade for sentir o ganho antes de pagar a dívida: **item 6 (memória)** é o
que mais muda a experiência de uso no dia a dia.

A trilha **P3** é ortogonal às outras: pode começar assim que P0.2, P0.4 e o item 9 estiverem
prontos, sem esperar o P1 inteiro. Mas **execução não supervisionada só depois dos itens 7 e 10** —
ver a regra em [§11.7](#117-ordem-de-dependência).

---

## 14. Questões em aberto

Pontos que este documento **não** resolve e que precisam de verificação antes de virar execução:

1. **Mecanismo exato de autenticação do Agent SDK contra a sessão do CLI.** A documentação da
   Anthropic indica que uso do Agent SDK consome o limite da assinatura, mas o *como* — se
   reaproveita o login do Claude Code na mesma máquina, como o `claude-runner.ts` faz hoje ao
   remover `ANTHROPIC_API_KEY` — precisa ser confirmado na prática, não na doc. **É premissa do
   item P1.5 e do ganho de custo.**

2. **Custo de contexto dos 67 schemas de tool.** Medir quantos tokens o catálogo completo consome
   no prompt do dev agent antes de decidir o quanto o escopo por papel (P2.10) rende.

3. **Plugin Obsidian companion.** `test-vault/.obsidian/plugins/obsidiankan-mcp` existe, mas não há
   código dele em `packages/*`. Determinar se existe fora do repo, se está morto, e se entra no
   roadmap.

4. **Auditoria dedicada de prompt injection via corpo de card.** A superfície foi identificada
   (card lido pelo agente + `acceptEdits` + `shell:true`), mas não foi traçada exaustivamente nem
   testada.

5. **Cobertura de teste real.** O relatório em disco está desatualizado; rodar `pnpm test` com
   cobertura para obter um retrato atual antes de decidir onde escrever teste novo.

6. **Longevidade do login do Claude no Pi.** O wizard e a triagem passam a rodar no Pi (§11.3),
   que precisa de uma sessão do Claude Code válida. Falta determinar: quanto tempo a sessão dura,
   se expira de forma detectável, e como alertar antes de uma sprint falhar silenciosamente de
   madrugada. **Premissa do item P3.18.**

7. **Wake-on-LAN de fato funciona nesta placa.** O suporte precisa ser confirmado com
   `sudo ethtool <iface> | grep -i wake` (procurar `g` em *Supports Wake-on*), depois de passar o
   cabo ethernet e habilitar no BIOS. Enquanto não for verificado, o item P3.17 é hipótese.

8. **Desempenho do Pi 5 como host do wizard de planejamento.** O wizard não compila nada, mas
   spawna o CLI do Claude e processa respostas longas. Medir latência real antes de assumir que
   a experiência de autoria no dashboard é aceitável.

9. **Formato real das mensagens de esgotamento de cota.** O supervisor determinístico (§12.4)
   depende de reconhecer o texto de reset. Falta coletar amostras reais — o formato exato, se
   vem em `stderr`, no JSON de saída ou como campo estruturado, e se difere entre o CLI e o
   Agent SDK. **Enquanto isso não for amostrado, a regra de nível 1 é especulação.**
   Sugestão: registrar toda falha crua no audit log desde já, antes mesmo de escrever o supervisor.

10. **Qual provider usar no nível 2 do supervisor.** Precisa ser independente da Anthropic
    (§12.9) e estar disponível com a workstation suspensa. Decidir entre uma API barata de
    terceiro ou aceitar que o nível 2 só funciona com a máquina acordada.

11. **Fuso horário e semântica de "4AM".** Reset de cota é anunciado em qual fuso? O agendamento
    precisa disso correto, ou a retomada acontece horas antes ou depois. Verificar contra o
    comportamento real da API antes de confiar no parse.

---

## Referências

### Documentação oficial

- [Building Agents with the Claude Agent SDK — Anthropic](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)
- [Intercept and control agent behavior with hooks — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/hooks)
- [Use the Claude Agent SDK with your Claude plan — Anthropic Support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)

### Harnesses de referência

- [sipeed/picoclaw (GitHub)](https://github.com/sipeed/picoclaw)
- [PicoClaw Deep Dive — A Field Guide to Building an Ultra-Light AI Agent in Go](https://dev.to/truongpx396/picoclaw-deep-dive-a-field-guide-to-building-an-ultra-light-ai-agent-in-go-ojd)
- [openclaw/openclaw (GitHub)](https://github.com/openclaw/openclaw)
- [Memory overview — OpenClaw Docs](https://docs.openclaw.ai/concepts/memory)
- [How OpenClaw Implements Agent Memory: A Code Walkthrough — MMNTM](https://www.mmntm.net/articles/openclaw-memory-architecture)
- [NousResearch/hermes-agent (GitHub)](https://github.com/nousresearch/hermes-agent)
- [OpenClaw vs Hermes Agent: The best agent harness in 2026 — Composio](https://composio.dev/content/openclaw-vs-hermes-agent)

### Engenharia de harness

- [Agent Harness Engineering — Addy Osmani](https://addyosmani.com/blog/agent-harness-engineering/)
- [Agent Harness Engineering Guide — DataCamp](https://www.datacamp.com/tutorial/agent-harness-engineering)
- [A Systematic Security Evaluation of OpenClaw and Its Variants (arXiv)](https://arxiv.org/pdf/2604.03131)
- [Safety in Self-Evolving LLM Agent Systems (arXiv)](https://arxiv.org/pdf/2606.23075)

### Prior art e metodologia

- [github/spec-kit — Spec-Driven Development toolkit](https://github.com/github/spec-kit)
- [Spec-driven development with AI — GitHub Blog](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)
- [vibe-kanban — a Kanban board for AI agents](https://virtuslab.com/blog/ai/vibe-kanban)
- [Claude Code Task Management: A Kanban Board Your AI Agents Update](https://www.codeagentswarm.com/en/guides/claude-code-task-management)

### Documentos internos

- `docs/for-developers/vistoria-2026-09-05.md` — autoavaliação com achados P0/P1/P2/P3
- `CLAUDE.md` — instruções operacionais e incidente documentado
- `docs/for-developers/architecture.md`
- `packages/shared/src/index.ts` — contrato de tipos normativo
