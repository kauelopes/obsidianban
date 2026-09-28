# PicoClaw

> **Papel na nossa pesquisa: a planta.**
> É o único harness pequeno o suficiente para ler inteiro. Serve como livro-texto de
> arquitetura de agente, não como agente a ser adotado.
> Documento de referência — 2026-09-20. Ver [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md).

---

## 1. Identidade

| | |
|---|---|
| **Mantenedor** | **Sipeed** — empresa chinesa de hardware (placas RISC-V, NanoKVM, MaixCAM) |
| **Repositório** | `github.com/sipeed/picoclaw` |
| **Linguagem** | Go (binário estático único) |
| **Licença** | open source, compatível com MIT |
| **Estrelas / Forks** | ~30.000 / ~4.500 |
| **Commits** | **2.584** (main) |
| **Versão** | v0.2.9 (mais recente observada) |
| **Natureza** | **runtime** (não plataforma, não agente) |

**Fato notável:** ~95% do código core foi gerado por agente, com revisão humana no loop.

### ⚠️ Aviso do próprio repositório

> *"Desenvolvimento rápido inicial. Pode haver problemas de segurança não resolvidos.
> **Não faça deploy em produção antes da v1.0.**"*

Isso desqualifica o PicoClaw como agente de produção, mas não como referência arquitetural.

### Alvo de hardware

Projetado para hardware de US$ 10: LicheeRV-Nano (US$ 9,99), Raspberry Pi Zero 2 W, NanoKVM,
MaixCAM, roteadores MIPS, Android via Termux. Cross-compile para x86-64, ARM, ARM64, RISC-V,
MIPS LE, LoongArch, Darwin, Windows, NetBSD.

**Footprint:** binário de 5,5 MB sem dependências de runtime; consumo original <10 MB de RAM,
hoje **10–20 MB** *"por causa de merges rápidos de PR"* (otimização planejada). Startup <1s mesmo
em CPU single-core de 0,6 GHz.

> **Nota de aplicabilidade:** a obsessão por frugalidade nasce da restrição de rodar em 64 MB de
> RAM. Num Pi 5 ou servidor comum essa restrição não existe — separe os padrões que vêm de boa
> engenharia dos que vêm dessa dieta.

---

## 2. Arquitetura — o pipeline de quatro estágios

O coração, e a razão de o projeto valer como referência:

```
pipeline_setup.go     → monta prompt, carrega histórico, resolve modelo, monta hooks
pipeline_llm.go       → chama provider com streaming, parseia tool calls
pipeline_execute.go   → executa ferramentas, aplica approval gates, registra resultados
pipeline_finalize.go  → persiste sessão, emite eventos, envia mensagens de saída
```

> *"Cada arquivo de pipeline exporta uma única função que recebe e devolve o estado do turno.
> Mais fácil de testar, de adicionar tracing e de injetar hooks."*

É o loop `coletar → agir → verificar → repetir` na forma mais limpa disponível: quatro arquivos,
quatro funções, um tipo de estado (`TurnState`).

**Consequência arquitetural que importa:** com `TurnState → TurnState`, o estágio do meio vira
peça trocável. É o padrão que recomendamos adotar no ObsidianKan, com o Agent SDK ocupando os
estágios 2 e 3.

---

## 3. Gerenciamento de contexto

`context_budget.go` implementa gestão consciente de tokens, não truncamento ingênuo:

- Rastreia consumo de tokens por turno
- Impõe teto de orçamento por turno
- Corta as mensagens mais antigas quando a janela excede o limite do modelo
- **Opcionalmente resume em vez de descartar** contexto crítico

### Roteamento cheap-first

Economia de contexto aplicada na camada de modelo: um classificador pontua o pedido de **0 a 1**
usando contagem de tokens, presença de blocos de código, chamadas de ferramenta recentes e
anexos. Abaixo do limiar, roteia para um modelo mais barato.

---

## 4. Memória — a limitação deliberada

| Aspecto | Implementação |
|---|---|
| Formato | **JSONL append-only** com sidecars `.meta.json` |
| Propriedade | log imutável, à prova de crash, debugável com `tail -f` |
| Janela | **últimas 50 mensagens** em arquivo JSON local |
| Recall semântico | **não existe** |
| Vetorial | **não existe** |
| Longo prazo | **não existe** além da janela |

Há feature request aberto para backend persistente (Engram, issue #175), não implementado.

**Veredito:** o PicoClaw é conscientemente amnésico. É o preço de caber em 10 MB. Para um
"assistente que te conhece", esta é a parte a **não** copiar — use a arquitetura do
[OpenClaw](./OPENCLAW.md) ou do [Hermes](./HERMES.md).

---

## 5. Ferramentas — três camadas

### 5.1 Built-in (`pkg/tools/`)
Filesystem, execução de shell, interação com hardware, busca web. Registradas num registry
por turno que expõe schemas e requisitos de aprovação.

### 5.2 MCP — isolamento de processo
`pkg/mcp/manager` possui as conexões; `isolated_command_transport.go` faz o trabalho:

> *"Spawna cada servidor MCP num processo isolado... Impede que um servidor bugado derrube
> o agente."*

JSON-RPC sobre stdio. Do ponto de vista do modelo, ferramenta MCP é indistinguível de built-in
depois de registrada.

**⚠️ Bug conhecido:** [issue #1299](https://github.com/sipeed/picoclaw/issues/1299) — MCP é
ignorado completamente no modo `picoclaw agent`; funciona no modo gateway.

### 5.3 Skills
Bundles instaláveis carregados de arquivos `SKILL.md` no workspace. Podem contribuir com
ferramentas, hooks, configs de provider ou prompts. Registries: ClawHub e GitHub.

### Busca web
DuckDuckGo, Gemini, Baidu, Tavily, Brave, Kagi, Perplexity, SearXNG, GLM Search.

### Providers LLM (30+)
OpenAI, **Anthropic**, Google Gemini, OpenRouter, Zhipu, DeepSeek, Volcengine, Qwen, Groq,
Moonshot (Kimi), Minimax, Mistral, NVIDIA NIM, Cerebras, NEAR AI Cloud, Novita, Xiaomi MiMo,
Ollama, vLLM, LiteLLM, Azure OpenAI, GitHub Copilot, Antigravity, AWS Bedrock.

> **Anthropic é via API key.** Não há rota equivalente à do Claude CLI do OpenClaw para
> reaproveitar assinatura.

---

## 6. Orquestração — SubTurns

Subagentes hierárquicos com limites explícitos:

| Limite | Valor |
|---|---|
| Profundidade máxima | **3 níveis** |
| SubTurns concorrentes por pai | **5** |
| Slots de resultado | 16 |
| Fila de steering | 10 itens |

Cada SubTurn spawna um loop aninhado isolado com timeout independente e uma flag `Critical`
que determina se ele sobrevive à conclusão do pai.

### Modelo de concorrência Go

Goroutines estritamente contadas:
- uma por listener de canal ativo
- uma por turno ativo
- uma por SubTurn em execução (teto de 5 por pai)
- uma por processo de hook spawnado
- uma por transporte MCP

> *"Goroutines são baratas mas cada uma carrega uma stack — mantenha a conta."*

O design evita fan-out ilimitado via limites de capacidade explícitos.

---

## 7. Interruptibilidade — o padrão exclusivo

**Este é o tema que só o PicoClaw resolve bem, e vale copiar.**

Fila FIFO de *steering* por sessão, consultada em **quatro checkpoints** durante o turno. Permite
correção em tempo real no meio da execução.

O detalhe que revela maturidade: ferramentas puladas por causa de uma mensagem enfileirada
recebem resultado explícito:

```
"Skipped due to queued user message"
```

O modelo **sabe** que foi interrompido, em vez de concluir que a ferramenta falhou.

---

## 8. Hooks e observabilidade

- **5 pontos de hook síncronos**
- **EventBus** para observação read-only
- Princípio declarado: *"Observe tudo, intercepte raramente"*

Separar observação de interceptação evita que a observabilidade vire acoplamento.

### `membench`
Workload sintético no CI para impedir regressão de memória. É o **princípio do ratchet aplicado
ao próprio harness**: a falha virou teste permanente.

---

## 9. Canais e gateway

**19+ plataformas:** Telegram, Discord, WhatsApp, WeChat, QQ, Slack, Matrix, Delta Chat,
DingTalk, Feishu/Lark, LINE, WeCom, VK, IRC, OneBot, MQTT, MaixCam, Pico, Pico Client.

### Polimorfismo por capacidade
Todo canal embute `BaseChannel` e **opcionalmente** implementa interfaces:
`MediaSender`, `TypingCapable`, `ReactionCapable`, `MessageEditor`, `WebhookHandler`.

Capacidades são **descobertas por type assertion, não hardcoded** — adicionar plataforma nunca
toca o Manager.

### O Manager (não os canais) possui:
- filas de rate-limit por canal
- split de mensagem em fronteiras de frase/palavra abaixo do limite da plataforma
- retry com backoff exponencial classificado por tipo de erro
- indicadores de digitação e reações como decorações transparentes

Campos de primeira classe em `InboundMessage` (`Peer`, `MessageID`, `Sender`, `Body`) garantem
que roteamento e alocação de sessão não dependam de saco de metadados.

### Session store
Arrays de mutex com **64 shards** sobre `hash(key)` para serializar escritas sem mapa ilimitado.

> *"Lock striping é essencialmente de graça e resolve 99% dos bugs de contenção de session store."*

---

## 10. Os oito princípios declarados

1. **Enxuto por padrão, extensível por interface** — todo subsistema atrás de uma interface
2. **Um binário, toda arquitetura** — cross-compile amplo
3. **Persistência append-first (JSONL)** — logs imutáveis, crash-safe, debugáveis
4. **Promover dados de roteamento a campos de primeira classe** — sem metadados enterrados
5. **Capacidades descobertas, não hardcoded** — type assertions
6. **Barato primeiro, escale quando necessário** — classificador de custo
7. **Observe tudo, intercepte raramente** — EventBus + poucos hooks
8. **O usuário pode dirigir no meio da execução** — fila de steering

---

## 11. O que vale levar para o ObsidianKan

| Padrão | Aplicação |
|---|---|
| **Pipeline de 4 estágios com `TurnState`** | estruturar o runner LLM; torna o miolo trocável |
| **JSONL append-only + sidecar** | persistir estado do `WorkflowRunner` (hoje só em memória) |
| **Isolamento de processo por MCP** | proteção contra servidor MCP instável |
| **Fila de steering com skip explícito** | intervenção humana no meio de uma rodada de sprint |
| **EventBus read-only + poucos hooks** | substituir o parsing de emoji por eventos estruturados |
| **Roteamento cheap-first** | economia de cota/assinatura na triagem |
| **`membench` no CI** | ratchet aplicado ao próprio sistema |
| **Limites explícitos em tudo** | já parcialmente feito (50 rodadas, `DEV_DRAIN_LIMIT=3`) |

### O que **não** levar

- Go e binário estático (restrição de hardware alheia)
- Memória de 50 mensagens
- Lock striping de 64 shards, contagem obsessiva de goroutines
- Filas dimensionadas em 10/16 slots

---

## 12. Limitações conhecidas

- **Memória:** 50 mensagens, sem recall semântico, sem vetorial
- **Sem A2A:** *"cada instância PicoClaw é uma ilha"* — não dá para construir times, pipelines
  ou cadeias de delegação entre instâncias
- **Sem marketplace próprio** equivalente ao ClawHub
- **Verificação fraca:** tem approval gate, não tem separação gerador/avaliador nem LLM-as-judge
- **Segurança:** aviso explícito de pré-v1.0
- **Risco de bloat:** *"morte por mil cortes"* — pequenos aumentos de memória por PR podem
  inviabilizar o uso em dispositivos de 64 MB
- **MCP quebrado no modo agent** (issue #1299)

---

## Referências técnicas

### Código e documentação
- [sipeed/picoclaw — repositório](https://github.com/sipeed/picoclaw)
- [picoclaw no pkg.go.dev](https://pkg.go.dev/github.com/sipeed/picoclaw)
- [MCP Integration — DeepWiki](https://deepwiki.com/sipeed/picoclaw)

### Análise arquitetural
- [PicoClaw Deep Dive — A Field Guide to Building an Ultra-Light AI Agent in Go](https://dev.to/truongpx396/picoclaw-deep-dive-a-field-guide-to-building-an-ultra-light-ai-agent-in-go-ojd) — **a melhor fonte técnica**
- [PicoClaw vs OpenClaw (2026): Ultra-Minimal vs Full-Featured — CrewClaw](https://crewclaw.com/blog/picoclaw-vs-openclaw)
- [PicoClaw vs OpenClaw: A $10 Board Against a $600 Mac Mini](https://openclawpulse.com/picoclaw-vs-openclaw/)

### Issues relevantes
- [#1299 — MCP não funciona em agent mode](https://github.com/sipeed/picoclaw/issues/1299)
- [#290 — Implementação de suporte a MCP](https://github.com/sipeed/picoclaw/issues/290)
- [#175 — Engram como backend de memória persistente](https://github.com/sipeed/picoclaw/issues/175)
- [#346 — Prevenir bloat de memória](https://github.com/sipeed/picoclaw/issues/346)

### Documentos relacionados
- [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md) · [OPENCLAW.md](./OPENCLAW.md) · [HERMES.md](./HERMES.md) · [CLAUDE_AGENT_SDK.md](./CLAUDE_AGENT_SDK.md)
