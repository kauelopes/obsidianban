# Claude Agent SDK

> **Papel na nossa pesquisa: o miolo.**
> É a peça que vai ocupar os estágios 2 e 3 do pipeline do ObsidianKan, substituindo o
> `spawn('claude', ...)` atual. Entrega o loop pronto e — o que importa mais — **destrava os
> hooks** que resolvem os três buracos críticos do projeto.
> Documento de referência — 2026-09-20. Ver [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md).

---

## 1. O que é

O Claude Agent SDK entrega **o mesmo agent loop, ferramentas built-in e gerenciamento de
contexto que movem o Claude Code**, como biblioteca Python ou TypeScript.

Você pega o loop exato do Claude Code e o dirige do seu próprio programa, em vez de digitar num
terminal interativo. Instalar, chamar `query()`, e há um agente funcionando em ~10 linhas.

### 🎯 Nota crítica para o ObsidianKan

**O repositório é TypeScript.** Isso importa muito: o SDK de TypeScript expõe um conjunto de
hooks substancialmente maior que o de Python — incluindo `SessionStart`, `SessionEnd`,
`PostCompact` e, especialmente, **`TaskCompleted`**, cujo caso de uso documentado é literalmente
*"exigir testes passando antes de uma task fechar"*.

Estamos do lado certo da divisão.

---

## 2. O ciclo recomendado

A Anthropic recomenda um feedback loop de quatro fases:

```
coletar contexto → agir → verificar → repetir
```

É a mesma estrutura que move o Claude Code.

---

## 3. Divisão de responsabilidade

| O SDK entrega pronto | Você constrói |
|---|---|
| Acesso a filesystem e busca agêntica via bash | Definições das suas ferramentas |
| **Compactação de contexto** ao se aproximar do limite | **Mecanismos de verificação** de output |
| **Orquestração de subagentes** com janelas de contexto isoladas | Lógica de negócio e workflows |
| Integração com servidores **MCP** | Integração com APIs externas (MCP simplifica) |
| Geração e execução de código | |
| 14+ ferramentas built-in referenciadas por nome como string (Read, Write, Bash, Glob, Grep, WebSearch, WebFetch…) | |

Você **não** escreve o loop nem verifica `stop_reason === "tool_use"`.

### Compactação

Dispara quando o histórico excede o limite (**95% por padrão**) ou manualmente via `/compact`.
Resume mensagens antigas para que agentes de longa duração não estourem a janela.

---

## 4. Os desafios que a Anthropic sinaliza

**Gerenciamento de contexto.** O SDK dá a compactação, mas o desenvolvedor precisa projetar a
estrutura de arquivos estrategicamente:

> *"A estrutura de pastas e arquivos de um agente se torna uma forma de context engineering."*

**Design de ferramenta.** Ferramentas devem representar ações primárias e frequentes.
Alerta explícito: *"ferramentas são proeminentes na janela de contexto do Claude"* — design
cuidadoso maximiza eficiência.

**Verificação.** Três abordagens recomendadas: feedback baseado em regra (como linting),
feedback visual para tarefas de UI, e LLM-as-judge para avaliação difusa.

**Memória / persistência de contexto.** Gerenciada pelo desenvolvedor através de organização do
filesystem e recuperação seletiva — **não** armazenando tudo no contexto ativo.

---

## 5. ⭐ Hooks — o catálogo completo

Hooks são callbacks que rodam seu código em resposta a eventos do agente. Permitem:

- **Bloquear operações perigosas** antes de executarem
- **Registrar e auditar** toda chamada de ferramenta
- **Transformar entradas e saídas** — sanitizar, injetar credenciais, redirecionar caminhos
- **Exigir aprovação humana** para ações sensíveis
- **Rastrear ciclo de vida de sessão**

### Como funcionam

1. Um evento dispara durante a execução do agente
2. O SDK coleta os hooks registrados para aquele tipo de evento
3. **Matchers** filtram quais rodam (ex.: `"Write|Edit"` testado contra o nome da ferramenta);
   hooks sem matcher rodam para todo evento do tipo
4. O callback recebe um objeto tipado com os detalhes
5. O retorno controla o que acontece

### Tabela de eventos

| Evento | Python | TypeScript | Dispara em | Caso de uso documentado |
|---|:---:|:---:|---|---|
| `PreToolUse` | ✅ | ✅ | requisição de chamada de ferramenta (**pode bloquear ou modificar**) | bloquear comandos de shell perigosos |
| `PostToolUse` | ✅ | ✅ | resultado da execução | logar mudanças de arquivo em trilha de auditoria |
| `PostToolUseFailure` | ✅ | ✅ | falha na execução | tratar ou logar erros |
| `PostToolBatch` | ❌ | ✅ | lote completo de tool calls resolve, antes da próxima chamada ao modelo | injetar convenções uma vez por lote |
| `UserPromptSubmit` | ✅ | ✅ | submissão de prompt | **injetar contexto adicional no prompt** |
| `UserPromptExpansion` | ❌ | ✅ | comando digitado ou prompt MCP expande | bloquear comando ou adicionar contexto |
| `MessageDisplay` | ❌ | ✅ | mensagem do assistente completa | redigir/reformatar sem alterar o transcript |
| `Stop` | ✅ | ✅ | parada da execução | **salvar estado de sessão antes de sair** |
| `StopFailure` | ❌ | ✅ | turno termina com erro de API | logar falhas, enviar alertas |
| `SubagentStart` | ✅ | ✅ | inicialização de subagente | rastrear spawn paralelo |
| `SubagentStop` | ✅ | ✅ | conclusão de subagente | agregar resultados |
| **`PreCompact`** | ✅ | ✅ | **requisição de compactação (pode bloquear)** | **arquivar o transcript completo antes de resumir** |
| `PostCompact` | ❌ | ✅ | compactação completa | logar o resumo gerado |
| `PreModelSwitch` | ❌ | ✅ | troca de modelo solicitada (pode bloquear) | bloquear troca para um modelo específico |
| `PostModelSwitch` | ❌ | ✅ | modelo da sessão muda, incluindo fallback automático | dar orientação específica do novo modelo |
| `PermissionRequest` | ✅ | ✅ | tool call precisa de decisão de permissão | tratamento customizado de permissão |
| `PermissionDenied` | ❌ | ✅ | auto mode nega uma tool call | logar negações, permitir retry |
| `SessionStart` | ❌ | ✅ | inicialização de sessão | inicializar logging e telemetria |
| `SessionEnd` | ❌ | ✅ | término de sessão | limpar recursos temporários |
| `Notification` | ✅ | ✅ | mensagens de status do agente | enviar status para Slack/PagerDuty |
| `Setup` | ❌ | ✅ | setup/manutenção de sessão | rodar tarefas de inicialização |
| `TeammateIdle` | ❌ | ✅ | teammate fica ocioso | reatribuir trabalho ou notificar |
| `TaskCreated` | ❌ | ✅ | task criada via ferramenta `TaskCreate` | impor convenções de nomenclatura |
| **`TaskCompleted`** | ❌ | ✅ | **task marcada como completa** | **exigir testes passando antes da task fechar** |
| `Elicitation` | ❌ | ✅ | servidor MCP pede input do usuário | responder programaticamente |
| `ElicitationResult` | ❌ | ✅ | usuário responde a uma elicitation MCP | modificar ou bloquear a resposta |
| `ConfigChange` | ❌ | ✅ | arquivo de configuração muda | recarregar settings dinamicamente |

### Estrutura de retorno

```python
# Bloquear
return {
    "hookSpecificOutput": {
        "hookEventName": input_data["hook_event_name"],
        "permissionDecision": "deny",
        "permissionDecisionReason": "Cannot modify .env files",
    }
}

# Permitir sem mudanças
return {}
```

**Campos de topo** (aceitos em todo evento):
- `systemMessage` — mostra mensagem ao usuário
- `continue` (`continue_` em Python) — se o agente segue rodando após o hook

**`hookSpecificOutput`** varia por evento:

| Evento | Campos |
|---|---|
| `PreToolUse` | `permissionDecision` (`"allow"` / `"deny"` / `"ask"` / `"defer"`), `permissionDecisionReason`, `updatedInput` |
| `PostToolUse` | `additionalContext` (anexa info ao resultado), `updatedToolOutput` (substitui a saída antes do Claude ver) |
| `PostToolUse` (TS) | `classifierContext` — nota curta para o classificador do auto mode (requer TS SDK v0.3.236+) |

> ⚠️ **Precedência quando múltiplos hooks ou regras se aplicam:**
> `deny` > `defer` > `ask` > `allow`.
> Se qualquer hook retorna `deny`, a operação é bloqueada independentemente dos outros.

### `defer` — o gancho de interruptibilidade

Retornar `permissionDecision: "defer"` **encerra a query** para que você a retome depois.
É o equivalente funcional da fila de steering do [PicoClaw](./PICOCLAW.md).

### Saída assíncrona

Para hooks que só têm efeito colateral (log, webhook, métrica), evite bloquear o agente:

```python
async def async_hook(input_data, tool_use_id, context):
    asyncio.create_task(send_to_logging_service(input_data))
    return {"async_": True, "asyncTimeout": 30000}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `async` (`async_` em Python) | `true` | o agente segue sem esperar |
| `asyncTimeout` | `number` | timeout em ms para a operação em background |

> Saídas assíncronas **não podem** bloquear, modificar ou injetar contexto — o agente já seguiu
> em frente. Use apenas para efeitos colaterais.

### Registro (Python)

```python
options = ClaudeAgentOptions(
    hooks={
        "PreToolUse": [HookMatcher(matcher="Write|Edit", hooks=[protect_env_files])]
    }
)
async with ClaudeSDKClient(options=options) as client:
    await client.query("...")
```

### Registro (TypeScript)

```typescript
{
  hooks: {
    PreToolUse: [{ matcher: "Write|Edit", hooks: [protectEnvFiles] }]
  }
}
```

---

## 6. 💰 Faturamento e assinatura

**Esta é a premissa econômica do plano — e a única que ainda precisa de verificação prática.**

Estado atual, segundo a página oficial de suporte:

> **Em 15/06/2026 a Anthropic PAUSOU as mudanças anunciadas.** Atualmente Claude Agent SDK,
> `claude -p` e uso por apps de terceiros **ainda consomem os limites de uso da sua assinatura**.
> Não há crédito mensal separado no momento.

### O plano original (não ativo)

Uso do Agent SDK teria migrado para um pool de crédito distinto:

| Plano | Crédito mensal que teria |
|---|---|
| Pro | US$ 20 |
| Max 5x | US$ 100 |
| Max 20x | US$ 200 |
| Team (Standard) | US$ 20 |
| Team (Premium) | US$ 100 |
| Enterprise (Premium por assento) | US$ 200 |

Contas de Claude Platform com API key não recebem crédito; pay-as-you-go segue como antes.

### ⚠️ Riscos a monitorar

1. **É uma pausa, não um cancelamento.** Pode voltar.
2. **Agente 24/7 não supervisionado come cota rápido** — perfil de uso diferente de conversa interativa.
3. Para automação de produção compartilhada, a própria Anthropic recomenda API key com billing
   previsível em vez de crédito por assinatura.

### 🔍 O que falta confirmar

O **mecanismo exato** pelo qual o Agent SDK autentica contra a sessão logada do Claude Code na
mesma máquina — que é o que `planning/claude-runner.ts` explora hoje ao remover
`ANTHROPIC_API_KEY` do env do subprocesso.

**A documentação diz que o uso consome o limite do plano; o *como* precisa ser verificado na
prática antes de o item P1.5 virar execução.**

---

## 7. Mapeamento direto nos buracos do ObsidianKan

Esta tabela é a justificativa do item **P1.5** do roadmap.

| Buraco identificado | Hook | Bloqueia? |
|---|---|---|
| Memória não sobrevive à compactação | **`PreCompact`** | ✅ |
| Registrar o resumo gerado | `PostCompact` *(TS)* | ❌ |
| `MEMORY.md` / `PROJECT.md` não chegam ao agente | **`UserPromptSubmit`** | ✅ |
| `kanban_start_job` com `shell:true` sem allowlist | **`PreToolUse`** → `permissionDecision: "deny"` | ✅ |
| Auditar resultado de ferramenta | `PostToolUse` → `updatedToolOutput` | ✅ |
| Fase do workflow inferida por parsing de emoji | `SubagentStart` / `SubagentStop`, `PostToolBatch` *(TS)* | — |
| Estado do `WorkflowRunner` só em memória | `Stop` / `SessionEnd` *(TS)* | — |
| **Card fecha sem testes passarem** | **`TaskCompleted`** *(TS)* — caso de uso documentado é exatamente esse | ✅ |
| Steering no meio de uma rodada | `PreToolUse` → `"defer"` | ✅ |
| Inicializar telemetria por sessão | `SessionStart` *(TS)* | — |

**Nove problemas, um refactor.**

---

## 8. O padrão de integração recomendado

Estruturar o runner em estágios com estado explícito de turno (padrão do
[PicoClaw](./PICOCLAW.md)), com o SDK ocupando o meio:

```
setup     → carrega sessão, monta contexto, injeta memória, resolve modelo
  ↓
[ run ]   → Agent SDK: loop, compactação, subagentes, MCP    ← peça trocável
  ↓
finalize  → persiste estado, emite evento, atualiza board
```

Com `TurnState → TurnState`, o estágio do meio vira implementação substituível. Se um dia for
preciso assumir o loop por completo, `setup`, `finalize`, canais, persistência e memória
permanecem intocados.

### Disciplina de prompt caching

Ver a [seção 10 do HERMES.md](./HERMES.md#10--economia-de-prompt-caching). Resumo do que se
aplica aqui:

- Montar o system prompt **uma vez por sessão**; nunca mutar no meio
- Injetar memória em `UserPromptSubmit` no **início**, não durante
- Nada de `datetime.now()` ou IDs aleatórios no prefixo
- Prefixo estável: conversa de 10 turnos custa ~1,5× um único turno. Instável: **10×**

Para o dev agent, que roda rodadas repetidas sobre o mesmo projeto, isso é a diferença entre
consumir a cota da assinatura em dias ou em semanas.

---

## 9. Onde o SDK **não** ajuda

Honestidade sobre os limites:

- **Não é framework de memória.** A camada de memória (`MEMORY.md`, índice, destilação) é toda
  sua. Ver [OPENCLAW.md](./OPENCLAW.md) para a arquitetura de referência.
- **Não é gateway.** Canais, roteamento e sessões continuam do ObsidianKan.
- **Não decide design de ferramenta.** Os 67 schemas atuais continuam competindo por atenção.
- **Verificação é sua.** O SDK dá o hook (`TaskCompleted`); a regra ("testes verdes") você escreve.
- **O interior do loop segue parcialmente opaco.** Hooks dão pontos de interceptação, não
  controle total. Se um dia precisar de mais, é a hora de assumir o estágio 2.

---

## Referências técnicas

### Documentação oficial
- [Building Agents with the Claude Agent SDK — Anthropic](https://claude.com/blog/building-agents-with-the-claude-agent-sdk) ⭐
- [Intercept and control agent behavior with hooks — Claude Code Docs](https://code.claude.com/docs/en/agent-sdk/hooks) ⭐ **fonte da tabela da seção 5**
- [Use the Claude Agent SDK with your Claude plan — Anthropic Support](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) ⭐ **fonte da seção 6**
- [Índice completo da documentação](https://code.claude.com/docs/llms.txt)

### Guias de terceiros
- [The Claude Agent SDK: Subagents, Sessions and Why It's Worth It](https://www.ksred.com/the-claude-agent-sdk-what-it-is-and-why-its-worth-understanding/)
- [Claude Agent SDK Complete Guide — hidekazu-konishi.com](https://hidekazu-konishi.com/entry/claude_agent_sdk_complete_guide.html)
- [Claude Agent SDK: Build Production Agents (2026 Guide) — alloq.digital](https://alloq.digital/en/blog/claude-agent-sdk/)
- [PreCompact and PostCompact Hooks — Developers Digest](https://www.developersdigest.tech/guides/pre-post-compact-hook)
- [Claude Code Hooks Explained: The Deterministic Layer Around Your Agent](https://blakecrosley.com/blog/claude-code-hooks-explained)

### Engenharia de harness (contexto conceitual)
- [Agent Harness Engineering — Addy Osmani](https://addyosmani.com/blog/agent-harness-engineering/)
- [Agent Harness Engineering Guide — DataCamp](https://www.datacamp.com/tutorial/agent-harness-engineering)

### Documentos relacionados
- [MELHORIAS_HARNESS.md](../../MELHORIAS_HARNESS.md) · [PICOCLAW.md](./PICOCLAW.md) · [OPENCLAW.md](./OPENCLAW.md) · [HERMES.md](./HERMES.md)
