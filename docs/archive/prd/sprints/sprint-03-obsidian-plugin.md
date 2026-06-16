# Sprint 03 — Obsidian Plugin

**Objetivo:** Implementar o plugin Obsidian que renderiza o board Kanban, traduz interações do usuário em chamadas MCP e mantém a UI sincronizada via SSE. Todas as regras de implementação Obsidian (RULE-01 a RULE-10) devem ser satisfeitas.

**Pré-requisito:** Sprint 02 concluído — as 6 tools MCP operacionais, SSE endpoint disponível.

**Critério de encerramento:** plugin instalado em vault de teste, board renderizado, drag-and-drop funcional, edição de card via Obsidian nativo com advisory banner, todos os erros (409, 400, 500, offline) com feedback visual correto, painel de métricas de tokens funcional e todos os RULE checks passando.

---

## Tasks

| ID | Título | Tipo |
|---|---|---|
| TASK-17 | Configurar vault de teste dedicado e ambiente de desenvolvimento | `scaffold` |
| TASK-18 | Criar `manifest.json` e scaffold do plugin | `scaffold` |
| TASK-19 | Implementar cliente HTTP para o MCP | `implementation` |
| TASK-20 | Implementar renderização do board Kanban | `implementation` |
| TASK-21 | Implementar drag-and-drop de cards entre colunas | `implementation` |
| TASK-22 | Implementar criação de card via board | `implementation` |
| TASK-23 | Implementar SSE subscription para atualizações em tempo real | `integration` |
| TASK-24 | Conformidade com regras de lifecycle de eventos (RULE-02) | `hardening` |
| TASK-25 | Conformidade com Vault API — sem fs direto (RULE-03, 04, 05, 06) | `hardening` |
| TASK-26 | Implementar CSS com variáveis Obsidian e convenções de comandos (RULE-07, 08) | `implementation` |
| TASK-27 | Implementar acessibilidade obrigatória (RULE-09) | `hardening` |
| TASK-28 | Implementar collapse de frontmatter e advisory banner em cards | `implementation` |
| TASK-29 | Implementar handling de erros na UI (409 overlay, toasts, banner offline) | `implementation` |
| TASK-30 | Implementar optimistic UI com rollback | `implementation` |
| TASK-31 | Implementar endpoint HTTP de métricas de tokens | `implementation` |
| TASK-32 | Implementar painel de métricas no plugin | `implementation` |

---

## Task Details

### TASK-17: Configurar vault de teste dedicado e ambiente de desenvolvimento

**Tipo:** `scaffold`

**Descrição:**
Todo desenvolvimento do plugin deve usar um vault dedicado separado — nunca o vault pessoal do desenvolvedor (RULE-10). Isso garante que crashes, bugs de file watcher ou dados de teste não contaminem notas reais.

**Setup:**
- Criar vault de teste em diretório separado (ex: `test-vault/`)
- Apontar `npm run dev` para o diretório do plugin dentro desse vault
- Configurar MCP apontando para o mesmo vault de teste

**Definition of Done:**
- Vault de teste criado e separado do vault pessoal
- `npm run dev` compila e recarrega o plugin no vault de teste automaticamente
- MCP rodando contra o vault de teste

**Testes:**
- Modificar o plugin → Obsidian recarrega sem reinicialização manual
- Confirmar que nenhum arquivo do vault pessoal é afetado durante o desenvolvimento

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-18: Criar `manifest.json` e scaffold do plugin

**Tipo:** `scaffold`

**Descrição:**
O plugin usa APIs Node.js (`http.request` sobre localhost). Node.js não está disponível no Obsidian Mobile, portanto `isDesktopOnly: true` é **obrigatório** (RULE-01).

```json
{
  "id": "obsidiankan-mcp",
  "name": "ObsidianKan MCP",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "Multi-agent Kanban board via MCP",
  "author": "",
  "isDesktopOnly": true
}
```

**Definition of Done:**
- `isDesktopOnly: true` presente no `manifest.json`
- `minAppVersion` corresponde à versão mínima que suporta as APIs usadas
- Plugin carrega sem erros no Obsidian Desktop

**Testes:**
- Instalar plugin → Obsidian Desktop carrega sem erros no console
- Verificar `isDesktopOnly: true` via inspeção do `manifest.json`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-19: Implementar cliente HTTP para o MCP

**Tipo:** `implementation`

**Descrição:**
O plugin se comunica com o MCP exclusivamente via HTTP sobre localhost. Usar `http.request` do Node.js. Não usar `fetch` global pois não suporta SSE nativamente.

**Interface do cliente:**
- Métodos tipados para cada uma das 6 tools: `listCards`, `getCard`, `createCard`, `updateCard`, `moveCard`, `reorderCard`
- Erros retornam tipos discriminados: `ConflictError` (409), `ValidationError` (400), `ServerError` (500), `OfflineError`
- Base URL configurável nas settings do plugin

**Definition of Done:**
- Cada tool MCP tem método correspondente no cliente com tipos corretos
- Erros retornam tipos discriminados para uso na UI
- MCP offline → `OfflineError` retornado (não exception não tratada)

**Testes:**
- Chamar `listCards` via cliente → retorna array tipado de cards
- MCP offline → `OfflineError` retornado
- Resposta 409 → `ConflictError` com `current_card` e `conflicting_fields`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-20: Implementar renderização do board Kanban

**Tipo:** `implementation`

**Descrição:**
View principal do plugin. Renderiza colunas e cards buscando dados via `kanban_list_cards`. Cards ordenados por `position ASC` em cada coluna.

**Layout:**
- Colunas ordenadas conforme `columns` array do `_meta.json`
- Cada card exibe: `title`, badge de `priority` (low=cinza, medium=azul, high=laranja, critical=vermelho), `due_date` (vermelho+negrito se vencido), `assigned_to`
- View global: todos os projetos como seções empilhadas com contagem por coluna

**Regras de implementação:**
- View nunca armazenada como campo na classe Plugin (RULE-04)
- `onunload()` não chama `detachLeavesOfType()` (RULE-05)

**Definition of Done:**
- Board renderiza com dados reais do MCP
- Cards ordenados por `position` em cada coluna
- Priority badge com cores corretas
- Due date em vermelho quando vencida

**Testes:**
- Abrir board → colunas na ordem correta, cards ordenados por position
- Card com `due_date` anterior a hoje → data em vermelho e negrito
- Fechar e reabrir o plugin → board renderiza novamente sem erro

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-21: Implementar drag-and-drop de cards entre colunas

**Tipo:** `implementation`

**Descrição:**
Drag-and-drop chama `kanban_move_card` via MCP HTTP — nenhuma escrita direta em arquivo. O board reflete o movimento imediatamente (optimistic update, ver TASK-30) e reverte em caso de erro.

**Fluxo:**
1. Usuário inicia drag de um card
2. Drop em coluna destino → chamar `kanban_move_card` com `id`, `version` e `to_status`
3. Sucesso → board atualizado
4. 409 → exibir conflict overlay (TASK-29)
5. Outro erro → reverter e exibir toast

**Definition of Done:**
- Drag-and-drop chama `kanban_move_card` via HTTP — confirmado via network log
- Nenhuma escrita direta em arquivo `.md` a partir do plugin
- `version` enviada corresponde ao último estado conhecido do card

**Testes:**
- Arrastar card de "todo" para "doing" → `MOVE` no audit log do MCP
- Confirmar via network log que a chamada é HTTP para o MCP
- Verificar que nenhum `fs.write` acontece no plugin durante o drag

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-22: Implementar criação de card via board

**Tipo:** `implementation`

**Descrição:**
Formulário inline ou modal para criar cards diretamente pelo board. Chama `kanban_create_card` via MCP. Campos mínimos: `title`. Campos opcionais: `priority`, `due_date`, `assigned_to`, `tags`.

**Definition of Done:**
- Criação via board chama `kanban_create_card` via HTTP
- Card aparece na coluna correta após criação
- Validação client-side básica (title não-vazio) antes de chamar o MCP
- Erro de MCP exibe toast com mensagem

**Testes:**
- Criar card via board → card aparece na coluna, `CREATE` no audit log
- Tentar criar card sem title → botão de submit desabilitado ou erro client-side
- MCP retorna 400 → toast com mensagem de erro

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-23: Implementar SSE subscription para atualizações em tempo real

**Tipo:** `integration`

**Descrição:**
O plugin subscreve ao SSE endpoint do MCP para receber eventos de mudança em tempo real. Quando um evento chega, o board atualiza sem polling.

**Comportamento:**
- Board atualiza em até 500ms após qualquer mudança de card via MCP
- Reconexão automática se SSE cair; usar `Last-Event-ID` para replay de eventos perdidos
- Listener registrado via métodos de lifecycle do Obsidian (RULE-02)

**Mapeamento de eventos para ações na UI (§6.10):**

| Evento SSE | Ação no plugin |
|---|---|
| `CARD_CREATED` | Inserir card na coluna e posição indicadas |
| `CARD_UPDATED` | Re-fetch do card via `kanban_get_card` e re-render |
| `CARD_MOVED` | Mover card de `from_status` para `to_status` na posição indicada |
| `CARD_REORDERED` | Reordenar `affected_cards` na coluna conforme novas posições |
| `CARD_HUMAN_EDITED` | Re-fetch do card via `kanban_get_card` e re-render |
| `CARD_DELETED` | Remover card do board |

**Definition of Done:**
- Board atualiza em < 500ms após mudança via MCP
- Todos os 6 tipos de evento tratados com a ação correta na UI
- Reconexão automática com `Last-Event-ID` em caso de queda do SSE
- Listener limpo corretamente no `onunload` (RULE-02)

**Testes:**
- Agente externo cria card → board reflete em < 500ms sem interação do usuário
- Edição humana direta no `.md` → `CARD_HUMAN_EDITED` dispara re-fetch → board atualiza
- Deleção de card pelo manager → `CARD_DELETED` → card some do board
- Simular queda do SSE → reconexão automática com `Last-Event-ID` → eventos perdidos processados
- Recarregar plugin → SSE reconecta, sem listeners duplicados

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-24: Conformidade com regras de lifecycle de eventos (RULE-02)

**Tipo:** `hardening`

**Descrição:**
Todos os event listeners devem ser registrados através dos métodos de lifecycle do Obsidian para garantir cleanup automático. Uso direto de `addEventListener` vaza listeners ao recarregar o plugin.

**Regras:**
- Eventos de workspace → `this.registerEvent(this.app.workspace.on(...))`
- Eventos de DOM → `this.registerDomEvent(el, 'click', handler)`
- Intervalos → `this.registerInterval(window.setInterval(...))`
- **Proibido:** `window.addEventListener`, `document.addEventListener`, `setInterval` direto

**Definition of Done:**
- ESLint com `eslint-plugin-obsidianmd` reporta zero violações
- Recarregar o plugin 10x → sem acúmulo de listeners

**Testes:**
- Rodar ESLint no source → zero violações de RULE-02
- Recarregar plugin 5x → DevTools → sem event listeners duplicados acumulados

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-25: Conformidade com Vault API — sem fs direto (RULE-03, 04, 05, 06)

**Tipo:** `hardening`

**Descrição:**
Agrupamento de regras de API verificadas em conjunto via grep e inspeção.

**RULE-03:** leituras → `vault.process()`, exclusões → `fileManager.trashFile()`. Sem `require('fs')`.
**RULE-04:** sem `this.kanbanView` ou similar na classe Plugin. Recuperar view sob demanda.
**RULE-05:** `onunload()` não chama `detachLeavesOfType()`.
**RULE-06:** sem `as TFile` ou `as TFolder`. Narrowing via `instanceof`.

**Definition of Done:**
- `grep -r "require('fs')\|import fs\|as TFile\|as TFolder\|this\.view\|detachLeavesOfType" src/` → zero resultados
- Vault reads usam `Vault.process()`, deletions usam `FileManager.trashFile()`

**Testes:**
- Grep pelas strings proibidas → zero resultados
- Recarregar plugin → board não desaparece do workspace (RULE-05 validado)

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-26: Implementar CSS com variáveis Obsidian e convenções de comandos (RULE-07, 08)

**Tipo:** `implementation`

**Descrição:**
**RULE-07:** todas as cores usam variáveis CSS do Obsidian (`var(--color-base-100)`, etc.). Sem hex hardcoded. Todos os seletores com prefixo `.kanban-mcp-*`. Sem `<style>` injetados via JS.

**RULE-08:** IDs de comando em lowercase hyphenated, sem prefixo do plugin, sem sufixo "command". Nome display em sentence case. Sem hotkeys padrão no código.

**Definition of Done:**
- `grep -r "#[0-9a-fA-F]\{3,6\}" styles.css` → zero resultados
- Todos os seletores começam com `.kanban-mcp-`
- Comandos registrados seguem as convenções

**Testes:**
- Alternar entre tema claro e escuro → board adapta cores corretamente
- Inspecionar Command Palette → nomes em sentence case, sem prefixo

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-27: Implementar acessibilidade obrigatória (RULE-09)

**Tipo:** `hardening`

**Descrição:**
Obrigatório para publicação na comunidade Obsidian. Cobre navegação por teclado e leitores de tela.

**Requisitos:**
- Todos os elementos interativos acessíveis via Tab e Enter/Space
- Botões icon-only com `aria-label` descritivo
- Focus ring visível — nunca `outline: none` sem substituto

**Definition of Done:**
- Navegar por todo o board usando apenas teclado
- Todos os botões icon-only têm `aria-label`
- Focus ring visível em todos os elementos interativos

**Testes:**
- Navegar pelo board com Tab → foco passa por todos os elementos na ordem lógica
- Verificar `aria-label` em todos os botões sem texto visível
- Nenhum elemento tem `outline: none` sem substituto

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-28: Implementar collapse de frontmatter e advisory banner em cards

**Tipo:** `implementation`

**Descrição:**
Quando um card `.md` é aberto no editor Obsidian, o plugin detecta (via padrão `id: card-`) e aplica:
1. Colapsa o bloco de frontmatter via API nativa de fold
2. Injeta banner: _"Managed card — edit body freely. Frontmatter fields are auto-managed."_

**Definition of Done:**
- Abrir arquivo de card → frontmatter colapsado, banner visível
- Abrir nota normal → nenhum banner injetado
- Banner não duplicado ao fechar e reabrir

**Testes:**
- Abrir card `.md` → frontmatter colapsado, banner presente
- Abrir nota normal → sem banner
- Fechar e reabrir card → banner não duplicado
- Watcher reverter campo com arquivo aberto → Obsidian exibe "File changed on disk — reload?"

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-29: Implementar handling de erros na UI (409 overlay, toasts, banner offline)

**Tipo:** `implementation`

**Descrição:**
Cada tipo de erro MCP tem resposta visual específica.

- **409** — overlay de merge com `conflicting_fields` + opções: "Manter minha versão" / "Usar versão atual" / "Editar manualmente"
- **400** — toast com lista de `disallowed_fields`. Auto-dismiss em 5s
- **500** — toast com botão "Tentar novamente"
- **MCP Offline** — banner persistente no topo, board em read-only, health polling a cada 5s

**Definition of Done:**
- 409 exibe overlay com opções de resolução
- 400 exibe toast com campos inválidos
- 500 exibe toast com retry
- MCP offline → banner persistente + read-only → some ao reconectar

**Testes:**
- Simular 409 → overlay exibido com `conflicting_fields` listados
- Simular 400 → toast com lista de campos
- Derrubar o MCP → banner aparece em até 5s → reiniciar MCP → banner some em até 5s

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-30: Implementar optimistic UI com rollback

**Tipo:** `implementation`

**Descrição:**
Para ações do usuário (drag, criação), o board reflete a mudança imediatamente sem aguardar a resposta do MCP. Se o MCP retornar erro, o estado anterior é restaurado.

**Fluxo:**
1. Usuário executa ação
2. Board atualiza imediatamente (optimistic)
3. Chamada MCP em background
4. Sucesso → estado confirmado
5. Erro → estado anterior restaurado + feedback ao usuário

**Definition of Done:**
- Ações respondem imediatamente (< 16ms percebido)
- Erro MCP → estado anterior restaurado visivelmente
- Rollback não quebra a ordenação de outros cards na coluna

**Testes:**
- Arrastar card → movimento imediato no board, sem esperar resposta MCP
- Simular timeout no MCP → card volta à posição original, toast de erro exibido
- Múltiplos drags rápidos → rollback do último não afeta os anteriores confirmados

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-31: Implementar endpoint HTTP de métricas de tokens

**Tipo:** `implementation`

**Descrição:**
Endpoint somente leitura `GET /metrics` no MCP server que agrega os dados da tabela `token_log` e retorna um objeto JSON com todas as dimensões de consumo. Não requer token de autenticação de agente — autenticação por IP local é suficiente (localhost-only).

**Schema de resposta:**
```json
{
  "summary": {
    "total_input_tokens": 0,
    "total_output_tokens": 0,
    "total_ops": 0
  },
  "by_type": [
    { "type": "implementation", "input_tokens": 0, "output_tokens": 0, "ops": 0 }
  ],
  "by_day": [
    { "date": "2025-05-06", "input_tokens": 0, "output_tokens": 0 }
  ],
  "by_model": [
    { "model": "claude-opus-4-7", "input_tokens": 0, "output_tokens": 0 }
  ],
  "by_agent": [
    { "actor": "agent:codex-1", "input_tokens": 0, "output_tokens": 0 }
  ],
  "by_operation": [
    { "op": "CREATE", "input_tokens": 0, "output_tokens": 0, "count": 0 }
  ]
}
```

**Parâmetros de query opcionais:**
| Parâmetro | Tipo | Descrição |
|---|---|---|
| `from_date` | string | ISO 8601 — filtrar a partir desta data |
| `to_date` | string | ISO 8601 — filtrar até esta data |

**Definition of Done:**
- `GET /metrics` retorna o schema completo com dados reais da `token_log`
- `from_date` e `to_date` filtram corretamente
- Endpoint restrito a localhost — requisições de IPs externos retornam 403
- `token_log` vazia → todos os valores zerados, sem erro

**Testes:**
- Executar 10 operações mutantes → `GET /metrics` reflete totais corretos
- `GET /metrics?from_date=2025-05-01&to_date=2025-05-01` → retorna apenas ops daquele dia
- Requisição de IP externo → 403
- `token_log` vazia → resposta com zeros, status 200

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-32: Implementar painel de métricas no plugin

**Tipo:** `implementation`

**Descrição:**
View dedicada no sidebar do Obsidian (ItemView) que exibe as métricas de consumo de tokens. Consome o endpoint `GET /metrics`. Layout simples com tabelas — sem gráficos.

**Layout:**
- **Resumo:** total de input tokens, output tokens e operações
- **Por tipo de card:** tabela com colunas `Tipo | Input | Output | Ops`
- **Por dia (últimos 30 dias):** tabela com colunas `Data | Input | Output`
- **Por modelo:** tabela com colunas `Modelo | Input | Output`
- Botão "Atualizar" para refetch manual
- Filtros de data opcionais (`De:` / `Até:`) que disparam novo fetch

**Regras de implementação:**
- View registrada via `this.registerView(...)` — nunca armazenada como campo na classe Plugin (RULE-04)
- Listener de abertura registrado via `this.registerEvent(...)` (RULE-02)
- Cores via variáveis CSS do Obsidian (RULE-07)

**Definition of Done:**
- Painel abre via Command Palette ("Show metrics panel")
- Dados carregam automaticamente ao abrir
- Botão "Atualizar" refaz o fetch
- MCP offline → mensagem "MCP unavailable" no painel, sem crash
- Filtros de data funcionais

**Testes:**
- Abrir painel → tabelas preenchidas com dados reais
- Clicar "Atualizar" → dados atualizados
- MCP offline → painel exibe mensagem de indisponibilidade
- Filtrar por período → tabelas refletem apenas o intervalo selecionado
- Fechar e reabrir painel → nenhum listener duplicado

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:
