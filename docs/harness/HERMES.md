# Hermes Agent

> **Papel na nossa pesquisa: o loop que aprende.**
> É a referência para memória em camadas, skills auto-criadas e — o achado mais subestimado —
> **economia de prompt caching**. A seção 10 deste documento é a mais acionável de todas.
> Documento de referência — 2026-09-20. Ver [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md).

---

## 1. Identidade

| | |
|---|---|
| **Mantenedor** | **Nous Research** |
| **Repositório** | `github.com/NousResearch/hermes-agent` |
| **Lançamento** | fevereiro de 2026 |
| **Linguagem** | Python 3.11+ (TUI em Node.js/Ink) |
| **Natureza** | **agente** de vida longa, auto-aperfeiçoável |
| **Posicionamento** | *"The agent that grows with you"* |

Agente pessoal de longa duração que roda sem supervisão, opera através de plataformas de
mensageria e acumula conhecimento ao longo do tempo. Roda em *"um VPS de US$ 5, um cluster de
GPU ou infraestrutura serverless"* — sem GPU obrigatória.

**Instalação:**
```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
hermes setup --portal
hermes model            # troca de provider/modelo sem mexer em código
```

**Hermes Cloud** (hospedagem gerenciada): US$ 0,29–1,09/dia.

### Família de modelos

O projeto nasce da família **Nous Hermes** de LLMs open-weight afinados para function calling,
saída estruturada e uso agêntico. Hermes 2 Pro atingiu ~90% de acurácia em function calling
contra 60–70% de modelos generalistas de tamanho similar. Hermes 4.3 (ago/2025) foi treinado na
rede descentralizada Psyche, sobre base Seed 36B da ByteDance.

> **Importante:** o *Hermes Agent* é agnóstico de modelo. Usar os modelos Hermes é opcional.

---

## 2. Arquitetura — o loop de cinco estágios

```
1. Input Reception     → mensagens chegam via CLI, gateway, cron ou API
2. System Prompt       → montado UMA VEZ por sessão
3. Model Invocation    → auto-detecta modo de API
4. Tool Dispatch       → parseia, executa via registry, anexa resultado, repete
5. Persistence         → SQLite SessionDB com WAL + FTS5
```

### Montagem do system prompt (estágio 2)

Composto de: persona (`SOUL.md`) + dicas de plataforma + **snapshot congelado de memória** +
orientação de busca em sessões + índice de skills (nível 0) + schemas de ferramentas.

> ⚠️ **Detalhe crítico:** *"O system prompt é montado uma vez no início da sessão e não muta no
> meio da conversa"* — para manter a validade do cache de prompt. Escritas de memória em disco
> **não afetam o prefixo cacheado da sessão atual**; passam a valer na próxima.

Ver a seção 10 para por que isso é a decisão de custo mais importante do projeto.

### Modos de API auto-detectados
`chat_completions` · `codex_responses` · `anthropic_messages` · `bedrock_converse`

### IterationBudget

Teto padrão de **25 chamadas de ferramenta por turno**, contra loops infinitos.

- Ao esgotar: uma injeção de aviso, depois **uma chamada de graça** para raciocínio final,
  então sumarização forçada
- Subagentes **compartilham o orçamento do pai**
- Ferramentas como `execute_code` **devolvem iterações** ao completar

---

## 3. Perfis e layout de arquivos

Cada perfil possui um diretório `HERMES_HOME` (padrão `~/.hermes/`, sobrescrevível por variável
de ambiente).

> ⚠️ A troca de perfil precisa ocorrer **antes dos imports de módulo**, via
> `_apply_profile_override()` em `hermes_cli/main.py`.
> Todo caminho de filesystem usa o helper `get_hermes_home()` — caminhos `~/.hermes` hardcoded
> quebram o isolamento.

```
~/.hermes/
├── config.yaml              # modelo, toolsets, terminal backend, skin
├── .env                     # API keys, segredos
├── SOUL.md                  # identidade/voz do agente
├── MEMORY.md                # fatos (~2.200 caracteres de teto)
├── USER.md                  # modelo do usuário (~1.375 caracteres de teto)
├── skills/
│   ├── devops/deploy-staging/SKILL.md
│   ├── .hub/                # instaladas do hub
│   └── .bundled_manifest
├── sessions.db              # SQLite: conversas indexadas por FTS5
├── cron/
│   ├── jobs.json            # JSON, não SQLite — scheduler próprio
│   └── output/{job_id}/     # markdown por execução
├── skins/                   # temas em YAML
├── plugins/                 # plugins Python de usuário
└── .hermes_home_marker      # sentinela de validação do home dir
```

---

## 4. Memória — três camadas independentes

### Camada 1 — Snapshot congelado

`MEMORY.md` (fatos) e `USER.md` (modelo do usuário) lidos **uma vez** no início da sessão e
embutidos **imutavelmente** no system prompt via `MemoryStore`.

| Aspecto | Detalhe |
|---|---|
| Teto de tamanho | `MEMORY.md` ~2.200 chars · `USER.md` ~1.375 chars |
| Delimitação | marcados por `§` no prompt |
| Escrita mid-session | permitida em disco, mas a cópia no prompt não muda |
| Efeito | a escrita vale **na próxima sessão** |

**Varredura de segurança antes da injeção** detecta: prompt injection, exfiltração
(`curl`/`wget` com variáveis de ambiente), backdoors e ataques Unicode.

> Esse scan é um padrão que vale copiar: a memória é um vetor de injeção, porque o agente
> escreve nela e depois confia nela.

### Camada 2 — Recall cross-session via SessionDB

- SQLite em **modo WAL** (write-ahead logging) com tabela virtual **FTS5**
- Armazena todo turno de conversa
- Tool `session_search` consulta via FTS5; um **sumarizador LLM** condensa os hits num parágrafo
  contextual
- Contenção multi-processo tratada com `BEGIN IMMEDIATE` + loop de retry com jitter de 20–150 ms

### Camada 3 — Provider externo plugável

`MemoryProvider` como ABC única, com implementações intercambiáveis:

| Provider | Especialidade |
|---|---|
| **Honcho** | raciocínio dialético para modelagem de usuário |
| **mem0** | memória geral |
| **supermemory** | memória geral |

Hooks de ciclo de vida: `prefetch()` (antes da chamada de API), `sync_turn()` (após o turno),
`shutdown()`. **Apenas um provider ativo por vez.**

---

## 5. Ferramentas

### Registry auto-registrável

Ferramentas se registram no momento do import:

```python
registry.register(
    name="read_file",
    toolset="filesystem",
    schema={...JSON schema...},
    handler=read_file_handler,
    available=lambda ctx: True   # predicado de gating
)
```

Dois invariantes que valem copiar:

1. **Handlers sempre retornam strings JSON** — o modelo nunca vê objeto Python
2. **Exceções viram resultado de ferramenta** — nunca derrubam o loop

### Toolsets

~40+ ferramentas built-in agrupadas em conjuntos lógicos: `filesystem`, `web`, `browser`, `code`,
`mcp`, `vision`, `audio` e outros.

> Usuários habilitam/desabilitam **por toolset**, e os desabilitados **somem inteiramente do
> system prompt**. Isso é economia de contexto por configuração.

### Tool Search

Esconde os schemas de MCP e carrega ferramentas **sob demanda**, reduzindo poluição da janela de
contexto. É progressive disclosure aplicado a ferramentas.

---

## 6. Skills — o formato e a auto-criação

Uma skill é um **documento markdown com frontmatter YAML** que ensina o agente a fazer uma coisa:

```yaml
---
name: deploy-staging
description: Push branch to staging and verify health
version: 1.2.0
platforms: [macos, linux]
requires_toolsets: [shell, web]
required_environment_variables: [VERCEL_TOKEN]
tags: [deploy, vercel]
category: devops
---
## When to Use
## Procedure
## Pitfalls
## Verification
```

### Três níveis de disclosure

| Nível | O que carrega | Quando |
|---|---|---|
| **L0** | nome + descrição | **sempre** no system prompt (índice econômico) |
| **L1** | `SKILL.md` completo | quando o agente decide usar |
| **L2** | arquivos em `references/`, `scripts/` | sob demanda |

```
~/.hermes/skills/devops/deploy-staging/
├── SKILL.md
├── references/       # docs extras
├── templates/        # templates de arquivo
├── scripts/          # scripts auxiliares
└── assets/
```

### Auto-melhoria via `skill_manage`

Leitura: `skills_list` (navega L0) e `skill_view` (escala para L1/L2).
Escrita: `skill_manage` com `create` · `patch` (substituição cirúrgica, **preferido**) · `edit`
(reescrita completa) · `delete`.

O system prompt **nudge explicitamente** a criação de skill depois de resolver tarefas com 5+
chamadas de ferramenta ou ao descobrir contornos não óbvios. É o loop de aprendizado fechado: o
agente escreve os próprios manuais enquanto trabalha.

> Instalação a partir do hub é **user-driven apenas** — o agente não instala skill não confiável
> sozinha. Skills do hub passam por varredura de injeção/exfiltração/destruição antes de ganhar confiança.

**Catálogo:** 82 skills built-in + catálogo opcional de 117. Padrão aberto [agentskills.io](https://agentskills.io),
portável entre registries (ClawHub, LobeHub, skills.sh, browse.sh).

---

## 7. Execução — backends e blast radius

Abstração de ambiente em `tools/environments/`:

| Backend | Isolamento |
|---|---|
| **local** | máquina de dev, mais rápido, **sem isolamento** |
| **docker** | um container por sessão |
| **ssh** | VM remota |
| **modal** / **daytona** | sandboxes serverless |
| **singularity** | cluster HPC |

> *"Mesma ferramenta, blast radius diferente."* As mesmas `execute_code` e `run_shell` funcionam
> em todos; `terminal.backend` na config troca a implementação. O agente não tem consciência de
> qual backend está rodando.

*(Fontes divergem entre seis e sete backends — algumas listagens incluem Vercel Sandbox.)*

---

## 8. Aprovação e segurança — quatro camadas

Esta é a área onde o Hermes é o **mais conservador** dos três harnesses.

1. **Tirith** — scanner externo em Rust (auto-instalado, verificação SHA-256). Detecta URLs
   homográficas, injeção de terminal (escapes ANSI escondendo comandos) e padrões conhecidos.
2. **Detecção por regex** — string de comando normalizada (case-insensitive, whitespace
   colapsado) rastreada contra padrões perigosos.
3. **Risk-rating por LLM** — baixo risco auto-aprova; médio/alto bloqueia para aprovação humana.
4. **Escopos de aprovação** — `Once` / `Session` / `Permanent`. **A confiança acumula** em vez de
   re-perguntar.

Quando um gateway precisa de aprovação, um `threading.Event` bloqueia até a resposta humana.
`/yolo` contorna tudo em sessões confiáveis. **Backends sandboxed contornam automaticamente** —
o sandbox é a fronteira de segurança.

Interrupções (Ctrl-C) cancelam ferramentas em voo de forma limpa, anexam resultado
`"user interrupted"` e devolvem o controle.

### Hooks de plugin

`pre_tool` / `post_tool` · `pre_llm` / `post_llm` · `session_start` / `session_end`

---

## 9. Gateways e canais

Seis superfícies distintas, **um único loop core**:

| Superfície | Tecnologia | Chave de sessão |
|---|---|---|
| CLI | Rich + prompt_toolkit | diretório de trabalho local |
| TUI | Node.js Ink + JSON-RPC para Python | diretório de trabalho local |
| Telegram | python-telegram-bot | user ID estável |
| Discord | discord.py ou API | user + channel ID |
| Slack | bolt-python ou API | user + channel ID |
| Web UI | React SPA + FastAPI | tokens de sessão efêmeros |
| ACP (Zed/VSCode) | protocolo ACP | workspace do editor |
| Cron | loop de tick próprio de 60s | job ID + timestamp |

Cada adaptador: auth → derivação de chave de sessão → `AIAgent.run_conversation()` → formatação
→ envio. *Mesmo agente, mesma memória, mesmas skills, UI diferente.*

**20+ plataformas** no total, incluindo WhatsApp, Signal, Matrix e Teams.

### Cron

Scheduler **próprio**, não APScheduler. Jobs em `~/.hermes/cron/jobs.json`; saídas em
`~/.hermes/cron/output/{job_id}/{timestamp}.md`. Suporta intervalos, cron de 5 campos, timestamps
ISO, prompt anexado e lista opcional de skills. Cada tick cria um `AIAgent` fresco **sem
histórico**, anexa as skills, roda o prompt e entrega a saída.

### Multi-agente
**Bot Mode** cria bots nomeados persistentes com identidades separadas; suporta grupos de 2–6
agentes em discussão multi-rodada e comunicação **A2A** via filas de mensagem assíncronas.
Subagentes herdam perfil/toolset e compartilham o `IterationBudget` do pai.

---

## 10. ⭐ Economia de prompt caching

**A seção mais acionável deste documento.** Descrita como *"a maior alavanca de custo isolada"*.

### Fazer

- Montar o system prompt **uma vez por sessão**
- Inserir cache breakpoints específicos do provider — no Anthropic:
  `cache_control: {type: "ephemeral"}` na última mensagem estática
- Usar o **padrão de snapshot congelado**: ler MEMORY/USER uma vez e embutir imutavelmente,
  mesmo que os arquivos mudem depois
- **Adiar mudanças de config para a próxima sessão** (liga/desliga toolset, troca de modelo)

### Não fazer

- Recarregar memória no meio da conversa
- Adicionar/remover ferramentas no meio da conversa
- Mutar o system prompt — **nada de `datetime.now()`, IDs aleatórios**
- Variar o system prompt por turno

### O número

Leitura de prefixo cacheado é **~10× mais barata** que escrita.

| Prefixo | Custo de uma conversa de 10 turnos |
|---|---|
| **estável** | ~1,5× o custo de um único turno |
| instável | **10×** |

> **Relevância direta para o ObsidianKan:** o dev agent roda em rodadas repetidas sobre o mesmo
> projeto. Um prefixo estável entre rodadas é a diferença entre consumir a cota da assinatura em
> dias ou em semanas. E é exatamente por isso que a injeção de `MEMORY.md`/`PROJECT.md` deve
> acontecer no **início da sessão** (via `UserPromptSubmit`), nunca no meio.

**Teste de CI sugerido pelo próprio guia:** verificar que o system prompt é byte-idêntico entre
o turno 1 e o turno 10.

---

## 11. O loop de auto-evolução

```
1. Agente encontra tarefa que exige múltiplas chamadas de ferramenta
2. Após o sucesso, SKILLS_GUIDANCE nudge: "quando terminar algo difícil, escreva uma skill"
3. Agente chama skill_manage create → escreve SKILL.md em ~/.hermes/skills/
4. Agente também atualiza MEMORY.md com as lições aprendidas
5. Próxima sessão carrega skills atualizadas em L0 e a nova memória no snapshot congelado
6. O loop compõe — o agente fica progressivamente mais capaz
```

> *"Memória procedural > prompting esperto. A maior parte do comportamento inteligente vem de
> possuir uma pasta de documentos que o agente lê, escreve e faz crescer ao longo do tempo —
> não de engenharia de prompt."*

Há também `hermes-agent-self-evolution`, experimental, usando DSPy para otimizar a partir de
traces de execução.

⚠️ Loops auto-evolutivos têm classe de risco própria — ver
[Safety in Self-Evolving LLM Agent Systems](https://arxiv.org/pdf/2606.23075).

---

## 12. Configuração e segredos

Três fontes:

| Fonte | Conteúdo |
|---|---|
| `config.yaml` | modelo, toolsets, terminal backend, skin — não-secreto, versionável |
| `.env` | API keys, tokens — secretos, nunca logados |
| `config.yaml` da skill | configurações por skill |

Existem **três loaders independentes** (`load_cli_config`, `load_config`, YAML direto) porque
CLI, tool e gateway têm necessidades sutilmente diferentes. *A duplicação é intencional — não
unifique prematuramente.*

---

## 13. ⚠️ Autenticação Anthropic — a limitação para nós

O Hermes suporta a **API da Anthropic**, mas **não** autenticação por assinatura Claude.

Isso é um feature request aberto no próprio repositório:
[issue #25267 — Claude Agent SDK model provider with subscription OAuth](https://github.com/NousResearch/hermes-agent/issues/25267).

> **Consequência prática:** adotar o Hermes como agente significa pagar por token.
> Para o ObsidianKan, que já reaproveita a sessão logada, isso é um retrocesso econômico —
> e é a principal razão pela qual recomendamos **estudar** o Hermes, não adotá-lo.

---

## 14. O que vale levar para o ObsidianKan

| Padrão | Prioridade | Aplicação |
|---|---|---|
| **Snapshot congelado de memória** | **P1** | ler `MEMORY.md`/`PROJECT.md` uma vez por sessão, embutir imutável |
| **Disciplina de prompt caching** | **P1** | prefixo estável entre rodadas do dev agent = economia de cota |
| **Teto de caracteres na memória** | **P1** | ~2.200 / ~1.375 chars — força destilação em vez de acumulação |
| **Scan de segurança antes de injetar memória** | **P1** | a memória é vetor de injeção; o card também |
| **`IterationBudget` com chamada de graça** | P2 | já existe teto de rodadas; falta o warning + grace |
| **Handler sempre retorna JSON; exceção vira resultado** | P2 | robustez do loop de tools |
| **Toolsets desabilitados somem do prompt** | **P2** | resolve os 67 schemas competindo por atenção |
| **Skills em 3 níveis de disclosure** | P2 | as skills `.claude/skills/kanban-*` já existem; falta o L0/L1/L2 |
| **Nudge de criação de skill após tarefa difícil** | P2 | o ratchet automatizado |
| **Escopos de aprovação `Once`/`Session`/`Permanent`** | **P0** | confiança acumulada em vez de `acceptEdits` cego |
| **Backend de execução configurável** | P2 | local/docker/ssh — mesmo tool, blast radius diferente |
| **Teste de CI: system prompt byte-idêntico turno 1 vs 10** | P1 | ratchet aplicado ao caching |

### O que **não** levar

- A dependência de API key (perde a assinatura)
- A complexidade de perfis múltiplos — o ObsidianKan tem um só contexto
- Bot Mode / A2A — sem caso de uso claro hoje

---

## Referências técnicas

### Código e documentação
- [NousResearch/hermes-agent — repositório](https://github.com/nousresearch/hermes-agent)
- [Hermes Agent Documentation](https://hermes-agent.nousresearch.com/docs/)
- [Skills System — Hermes Docs](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/)
- [Bundled Skills Catalog](https://hermes-agent.nousresearch.com/docs/reference/skills-catalog)
- [skills.md no repositório](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)
- [NousResearch/Hermes-Function-Calling](https://github.com/NousResearch/Hermes-Function-Calling)

### Análise arquitetural
- [Hermes Agent Deep Dive & Build-Your-Own Guide](https://dev.to/truongpx396/hermes-agent-deep-dive-build-your-own-guide-1pcc) ⭐ **melhor fonte técnica**
- [Nous Research Hermes Agent: Setup and Tutorial Guide — DataCamp](https://www.datacamp.com/tutorial/hermes-agent)
- [Hermes Agent — Agentic AI Knowledge Base](https://agentic-ai.readthedocs.io/en/latest/AgentPlatforms/hermes-agent/)

### Ecossistema
- [awesome-hermes-skills — 350+ tools, memory providers](https://github.com/ZeroPointRepo/awesome-hermes-skills)
- [awesome-hermes-agent — diretório independente](https://github.com/0xNyk/awesome-hermes-agent)
- [agentskills.io — padrão aberto de skills](https://agentskills.io)

### Comparações e segurança
- [OpenClaw vs Hermes Agent: The best agent harness in 2026 — Composio](https://composio.dev/content/openclaw-vs-hermes-agent)
- [Safety in Self-Evolving LLM Agent Systems (arXiv)](https://arxiv.org/pdf/2606.23075)

### Issues relevantes
- [#25267 — subscription OAuth via Claude Agent SDK](https://github.com/NousResearch/hermes-agent/issues/25267)

### Documentos relacionados
- [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md) · [PICOCLAW.md](./PICOCLAW.md) · [OPENCLAW.md](./OPENCLAW.md) · [CLAUDE_AGENT_SDK.md](./CLAUDE_AGENT_SDK.md)
