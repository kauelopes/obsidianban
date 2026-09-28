# OpenClaw

> **Papel na nossa pesquisa: o catálogo de memória.**
> Grande demais para ler inteiro (97 mil commits), mas contém a melhor arquitetura de memória
> de agente que encontramos. Consulta cirúrgica, não adoção.
> Documento de referência — 2026-09-20. Ver [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md).

---

## 1. Identidade

| | |
|---|---|
| **Mantenedor** | **OpenClaw Foundation** — organização sem fins lucrativos |
| **Repositório** | `github.com/openclaw/openclaw` |
| **Licença** | **MIT** |
| **Linguagem** | TypeScript / JavaScript (+ crates Rust) |
| **Runtime** | Node.js **24.16+** ou **26.1+** |
| **Estrelas / Forks** | **~390.200** / ~82.000 |
| **Commits** | **97.542** (main) |
| **Natureza** | **plataforma** (não runtime, não agente) |

### Por que TypeScript

Escolha declarada e justificada:

> *"OpenClaw é primariamente um sistema de orquestração — prompts, ferramentas, protocolos e
> integrações"*, otimizado para hackabilidade.

### Organização do repositório

```
src/        # core TypeScript
packages/   # módulos
apps/       # aplicações
crates/     # componentes Rust
ui/         # interface
skills/     # capacidades estendidas
docs/
deploy/
```

---

## 2. Arquitetura — o Gateway como control plane

O centro de gravidade. Descrito na própria documentação como *"o tronco cerebral"*: processo de
vida longa que recebe mensagem, decide o que fazer, chama o modelo, executa ferramentas e
devolve a resposta.

Arquitetura logicamente dividida em **quatro camadas**: acesso → roteamento → negócio → armazenamento.

### Protocolo do Gateway

| Aspecto | Implementação |
|---|---|
| Transporte | WebSocket com frames de texto carregando JSON |
| Contrato | **API WebSocket tipada com validação por JSON Schema** |
| Bind padrão | `127.0.0.1:18789` |
| Padrões | request-response (`{type:"req"}` → `{type:"res"}`) e server-push (`{type:"event"}`) |
| Idempotência | **chaves de idempotência obrigatórias** em métodos com efeito colateral (`send`, operações de agente) |

### Duas categorias de cliente

- **Clientes de control-plane** — app macOS, CLI, web UI, automações
- **Nodes** — macOS/iOS/Android/headless, declaram `role: node` com capabilities explícitas

### Sessão e pareamento

Handshake obrigatório onde o cliente fornece identidade de dispositivo. Pareamento baseado em
device com aprovação armazenada num *device pairing store*. IDs novos exigem aprovação explícita;
conexões locais por loopback recebem auto-aprovação.

> **Observação:** isto é engenharia de sistema distribuído, não de agente. É o que separa o
> OpenClaw de um harness pessoal — e o que o torna grande demais para servir de planta.

---

## 3. Memória — a joia da coroa

**A parte que vale estudar.** É a arquitetura de memória mais completa entre os harnesses pesquisados.

### 3.1 Layout de arquivos

Armazenada como Markdown puro em `~/.openclaw/workspace`:

| Arquivo | Papel |
|---|---|
| `USER.md` | preferências e perfil estáveis, como **diretivas imperativas**, com metadados rastreando mudanças ao longo do tempo |
| `MEMORY.md` | fatos duráveis e decisões permanentes — **o único que recebe injeção completa no bootstrap** |
| `memory/YYYY-MM-DD.md` | notas diárias, observações, contexto detalhado — **indexado para busca, não injetado em todo prompt** |
| `DREAMS.md` | entradas de diário e sumários de consolidação para revisão humana |

**Princípio de destilação:** material nasce no log diário e **sobe** para `MEMORY.md` conforme
prova valor. O sistema carrega automaticamente os arquivos de hoje e ontem no reset de sessão.

Se `MEMORY.md` excede o orçamento de bootstrap, ocorre truncamento — sinal para o usuário
promover apenas sumários ou migrar detalhe para os arquivos diários.

### 3.2 Markdown é a verdade, SQLite é índice derivado

| Componente | Papel |
|---|---|
| `MEMORY.md` | fatos curados de longo prazo |
| `memory/YYYY-MM-DD.md` | logs diários append-only |
| `{agentId}.sqlite` | **embeddings e chunks para retrieval** — derivado, reconstruível |

Se o índice corromper, reconstrói-se. O dado real está em texto que o humano lê e edita.

### 3.3 Busca híbrida — união, não interseção

Quando há provider de embedding configurado, `memory_search` combina similaridade vetorial
(significado semântico) com match de keyword (termos exatos como IDs e símbolos de código).

**Peso padrão: 70% semântico / 30% keyword.** E a lógica é de **união ponderada**, não interseção:

> *"Se um chunk pontua alto em similaridade vetorial mas não contém a palavra-chave, ele entra
> mesmo assim."*

Match exato aparece sem relevância semântica, e vice-versa.

**Providers de embedding:** OpenAI por padrão; substituível por Gemini, Voyage, Mistral, Bedrock
ou opções locais via configuração.

### 3.4 Ferramentas de memória

| Tool | Função |
|---|---|
| `memory_search` | recuperação semântica + keyword sobre todos os arquivos indexados |
| `memory_get` | leitura direta de arquivo ou faixa de linhas, quando o agente sabe o que procura |
| `intent` | lembretes permanentes condicionados a evento (lembretes por tempo usam tarefas agendadas) |

### 3.5 O pre-compaction memory flush ⭐

**A melhor ideia dos três harnesses pesquisados.**

Antes da compactação resumir a conversa, o sistema dispara um **turno agêntico silencioso**
instruindo o modelo a salvar no disco o que importa.

Detalhes de implementação que revelam maturidade:

| Detalhe | Comportamento |
|---|---|
| Isolamento | roda sobre uma **cópia privada da conversa** — mensagens de faxina nunca aparecem em turnos futuros |
| Silêncio | responde `NO_REPLY` se não houver nada a guardar; o usuário nunca vê |
| Limiar | `softThresholdTokens = 4000`, `reserveTokensFloor = 20000` |
| Gatilho | dispara quando `contextWindow - reserveTokensFloor - softThresholdTokens` é cruzado |
| Deduplicação | contador `memoryFlushCompactionCount` impede flush duplicado no mesmo ciclo |
| Sandbox | workspace read-only ou sem acesso **pula o flush inteiro** |
| Estado padrão | **habilitado** |

> **Por que importa:** compactação sem flush é **perda silenciosa de informação**. O flush
> transforma compactação de descarte em arquivamento.

### 3.6 Dreaming — promoção em background

Promoção automática de conteúdo para `MEMORY.md`, com **gates de score, frequência de recall e
diversidade de query** para qualificar candidatos.

Desativável via `plugins.entries.memory-core.config.dreaming.enabled: false`. O modelo do
memory-flush também é sobrescrevível para inferência local.

### 3.7 Mapa de módulos (para consulta cirúrgica)

```
src/memory/hybrid.ts                  ← merge de resultados vetorial + keyword
src/memory/manager.ts                 ← orquestra buscas
src/memory/embeddings.ts              ← lógica de seleção de provider
src/auto-reply/reply/memory-flush.ts  ← o checkpoint pré-compactação
src/agents/tools/memory-tool.ts       ← interface exposta ao agente
```

**Cinco arquivos.** Esses valem ler mesmo sem adotar o projeto.

### 3.8 Os cinco princípios transferíveis

Destacados na análise de código do sistema de memória:

1. **Arquivos como verdade fundamental** — permite inspeção e edição humana
2. **Busca híbrida como união, não interseção**
3. **Salvamento proativo antes da perda de informação**
4. **Degradação graciosa** quando componentes falham
5. **Seleção de provider local-first com fallback para nuvem**

---

## 4. Skills e ferramentas

- **ClawHub** — marketplace nativo integrado à Control UI. É o marketplace mais forte entre os
  harnesses pesquisados.
- **Skill Workshop** — criação governada de skills com três modos: `auto` (padrão), `propose`, `off`
- **Background learning** — mantém skills do Workshop a partir de trabalho anterior
- **MCP** — suportado através da Control UI

### Subagentes e multi-agente

Foco em **delegação temporária** (subagentes) e, principalmente, em **humanos compartilhando uma
sessão única** — multiplayer, com rastreio de criador/dono, indicadores de presença, estado de
digitação e handoff de sessão entre máquinas e cloud workers.

---

## 5. Canais e superfícies

WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, WebChat — **15+ plataformas**.
Control UI, CLI e TUI conectam ao Gateway.

Um único processo Gateway possui todas as superfícies de mensageria simultaneamente.

---

## 6. Autenticação Anthropic — relevante para nós

Duas rotas:

| Rota | Mecanismo | Custo |
|---|---|---|
| **API key** | acesso à API Anthropic com billing por uso, via Anthropic Console | pago por token |
| **Claude CLI** | reaproveita um login existente do Claude Code **no mesmo host** | consome limite da assinatura |

> OpenClaw **não suporta assinatura Claude.ai diretamente**. A rota Claude CLI é o caminho
> indireto — e é o mesmo truque que o ObsidianKan já usa em `planning/claude-runner.ts` ao
> remover `ANTHROPIC_API_KEY` do env do subprocesso.

**Modelos recomendados pela doc:** `anthropic/claude-opus-5` (1M context),
`anthropic/claude-fable-5-1` (1M context, adaptive thinking), `anthropic/claude-sonnet-5`.

**Preço de referência (Fable 5.1):** input US$ 10/Mtok · output US$ 50/Mtok · cache read US$ 0,25/Mtok.

---

## 7. ⚠️ Segurança — o histórico

Este é o ponto onde o OpenClaw serve de **advertência**, não de modelo.

### Postura declarada na documentação

> *"Trate mensagens de entrada como input não confiável."*
> *"Ferramentas rodam no host a menos que sandboxing esteja configurado."*

**Sandboxing vem desligado por padrão.**

### Incidentes

| Incidente | Escala |
|---|---|
| **CVE-2026-25253** — RCE de um clique | **40.000+ instâncias** afetadas; 63% ainda vulneráveis antes do patch |
| **Envenenamento do ClawHub** | **341 entradas maliciosas**, 335 de uma única campanha coordenada, instalando malware que rouba credenciais |
| CVEs anteriores em 2026 | CVSS 8.8 e 9.9 |

### Leitura

O ecossistema aberto que permite milhares de skills é o mesmo que permite distribuição maliciosa.
Requer disciplina ativa de auditoria por parte do operador. Controles existem (sandbox Docker/SSH,
escopos por agente, controles de papel) — só não são o padrão.

**Lição para o ObsidianKan:** a pilha de riscos identificada na seção 7.3 do
[MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md) é a mesma classe de problema.
Defaults são arquitetura.

---

## 8. O que vale levar para o ObsidianKan

| Padrão | Prioridade | Aplicação |
|---|---|---|
| **Layout de memória em 4 arquivos** | **P1** | `MEMORY.md` + `PROJECT.md` + log diário + índice |
| **Pre-compaction memory flush** | **P1** | via hook `PreCompact` do Agent SDK |
| **Markdown verdade / banco índice derivado** | ✅ já feito | o ObsidianKan já faz isso desde maio |
| **Busca híbrida como união 70/30** | P2 | quando a camada de memória tiver volume |
| **Destilação diário → curado** | **P1** | o PM promove aprendizado da triagem para `PROJECT.md` |
| **Truncamento como sinal** | P2 | avisar quando `MEMORY.md` estoura o orçamento de bootstrap |
| **Idempotência em métodos com efeito colateral** | P2 | já parcialmente presente via `version` otimista |
| **Degradação graciosa** | P2 | índice reconstruível já existe (`startup/reconcile.ts`) |

### O que **não** levar

- A arquitetura de Gateway como control plane distribuído (device pairing, nodes, WebSocket
  tipado) — resolve um problema que o ObsidianKan não tem
- Os defaults de segurança
- O tamanho

---

## 9. Limitações

- **97.542 commits** — não é base, é dependência. Impossível dominar.
- **Sandboxing desligado por padrão** e histórico de CVE crítico
- **Marketplace como superfície de ataque** comprovada
- Memória cross-conversation chegou tarde (o Hermes sempre teve mais profundidade)
- Menos ênfase em agente pessoal de vida longa; foco em sessões compartilhadas por times

---

## Referências técnicas

### Código e documentação
- [openclaw/openclaw — repositório](https://github.com/openclaw/openclaw)
- [OpenClaw Docs](https://docs.openclaw.ai/)
- [Memory overview — OpenClaw Docs](https://docs.openclaw.ai/concepts/memory) ⭐
- [Anthropic provider — OpenClaw Docs](https://docs.openclaw.ai/providers/anthropic)
- [Raspberry Pi install — OpenClaw Docs](https://docs.openclaw.ai/install/raspberry-pi)
- [OpenClaw — Wikipedia](https://en.wikipedia.org/wiki/OpenClaw)

### Análise arquitetural
- [How OpenClaw Implements Agent Memory: A Code Walkthrough — MMNTM](https://www.mmntm.net/articles/openclaw-memory-architecture) ⭐ **melhor fonte sobre a memória**
- [OpenClaw Memory Masterclass — VelvetShark](https://velvetshark.com/openclaw-memory-masterclass)
- [210.000 GitHub Stars in 10 Days: What OpenClaw's Architecture Teaches Us](https://medium.com/@Micheal-Lanham/210-000-github-stars-in-10-days-what-openclaws-architecture-teaches-us-about-building-personal-ai-dae040fab58f)
- [OpenClaw Architecture & Setup Guide (2026) — Valletta](https://vallettasoftware.com/blog/post/openclaw-2026-guide)

### Segurança
- [A Systematic Security Evaluation of OpenClaw and Its Variants (arXiv)](https://arxiv.org/pdf/2604.03131)
- [OpenClaw vs Hermes Agent: An Honest 2026 Comparison — Context Studios](https://www.contextstudios.ai/blog/openclaw-vs-hermes-agent-an-honest-2026-comparison)

### Comparações
- [OpenClaw vs Hermes Agent: The best agent harness in 2026 — Composio](https://composio.dev/content/openclaw-vs-hermes-agent)

### Documentos relacionados
- [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md) · [PICOCLAW.md](./PICOCLAW.md) · [HERMES.md](./HERMES.md) · [CLAUDE_AGENT_SDK.md](./CLAUDE_AGENT_SDK.md)
