# Sprint 04 — Hardening & Acceptance

**Objetivo:** Validar o sistema completo contra todos os cenários adversos do PRD, garantir que os critérios de Definition of Done dos sprints anteriores se sustentam sob carga e falhas, e produzir o guia de integração para agentes externos.

**Pré-requisito:** Sprints 01, 02 e 03 concluídos — sistema completo rodando (MCP + file watcher + plugin).

**Critério de encerramento:** todos os 11 E2E acceptance tests (§14.3) passando com evidência documentada. Sistema considerado pronto para V1.

---

## Tasks

| ID | Título | Tipo |
|---|---|---|
| TASK-33 | Testes de simulação de sync externo | `testing` |
| TASK-34 | Stress test de reconciliação na inicialização (1000+ cards) | `testing` |
| TASK-35 | Executar todos os E2E Acceptance Tests (§14.3) | `testing` |
| TASK-36 | Produzir guia de integração para agentes | `documentation` |

---

## Task Details

### TASK-35: Testes de simulação de sync externo

**Tipo:** `testing`

**Descrição:**
Simular o comportamento de ferramentas de sync de arquivos (ex: Syncthing, iCloud Drive) que escrevem diretamente nos `.md` sem passar pelo MCP.

**Cenário A — Mutação externa com MCP ativo:**
1. Agente leu card na versão 5
2. Ferramenta de sync escreve diretamente no `.md` (simulado via `fs.writeFile`)
3. File watcher detecta → processa → version 5 → 6 → log `EXTERNAL_MUTATION`
4. Agente tenta update com version 5 → 409 com `current_version: 6`

**Cenário B — Mutação externa com MCP offline:**
1. MCP para
2. Arquivo `.md` modificado externamente
3. MCP reinicia → startup hash-check detecta divergência → reconcilia → log `RECONCILED`

**Definition of Done:**
- `EXTERNAL_MUTATION` logado em até 200ms após escrita externa (MCP ativo)
- Agente recebe 409 na próxima tentativa após mutação externa
- Mutação offline detectada e reconciliada corretamente no startup

**Testes:**
- Escrever diretamente em `.md` com MCP ativo → `EXTERNAL_MUTATION` no log em < 200ms
- Tentar update de agente após mutação → 409 com version correta
- Parar MCP → modificar `.md` → reiniciar → card reconciliado, log `RECONCILED`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-36: Stress test de reconciliação na inicialização (1000+ cards)

**Tipo:** `testing`

**Descrição:**
Validar que a reconciliação de startup é correta e completa com volume alto de cards.

**Cenário A — SQLite deletado com 1000+ cards:**
1. Popular vault com 1000 cards via MCP
2. Deletar `db.sqlite`
3. Reiniciar MCP
4. Verificar que todos os 1000 cards são queryáveis e corretos

**Cenário B — 500 cards online + 500 criados offline:**
1. 500 cards no SQLite + `.md`
2. Criar 500 `.md` manualmente sem entrada no SQLite
3. Reiniciar → todos os 1000 presentes

**Cenário C — Orphan cleanup em escala:**
1. SQLite com 1000 entradas
2. Deletar 200 `.md` manualmente
3. Reiniciar → 200 orphan entries removidas, 800 cards presentes

**Definition of Done:**
- 1000 cards reconstruídos do zero sem perda após SQLite deletado
- Log `SQLITE_REBUILT` com `card_count` correto
- Orphan entries removidas corretamente em escala

**Testes:**
- Popular com 1000 cards → deletar SQLite → reiniciar → `kanban_list_cards` retorna todos os 1000
- Criar 500 `.md` manualmente → reiniciar → `kanban_list_cards` inclui os novos 500
- Deletar 200 `.md` → reiniciar → SQLite tem 800 entries, log mostra 200 `ORPHAN_REMOVED`

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-35: Executar todos os E2E Acceptance Tests (§14.3)

**Tipo:** `testing`

**Descrição:**
Executar e documentar resultado de cada cenário de acceptance test do PRD §14.3. Cada item deve ter status explícito (pass/fail) e evidência (log, screenshot, output).

**Acceptance tests:**

| # | Cenário | Critério de Pass |
|---|---|---|
| AT-01 | Agent B requests Project A card | 404 retornado |
| AT-02 | Agent A cria card com `request_id`, retry | 1 `.md`, respostas idênticas |
| AT-03 | Agent A envia `owner` no update | 400 `disallowed_fields: ["owner"]` |
| AT-04 | Agent A move card com version correta | version+1, `MOVE` no audit log |
| AT-05 | Agent A move card com version stale | 409 com `current_card` |
| AT-06 | Human edita `id` no frontmatter | `id` revertido em < 600ms, body preservado, `FIELD_REVERTED` no log |
| AT-07 | Human corrompe frontmatter (remove `---`) | arquivo revertido em < 600ms, `PARSE_ERROR` logado |
| AT-08 | Escrita de sync externo simulada | `EXTERNAL_MUTATION` em < 200ms; próximo write do agente → 409 |
| AT-09 | Delete SQLite + restart MCP | todos os cards queryáveis, log `SQLITE_REBUILT` |
| AT-10 | Edição concorrente agente + humano | edição humana aplicada em cima da do agente como versão separada; ambas as mudanças preservadas onde campos não se sobrepõem |
| AT-11 | Reordenar 5 cards | positions normalizadas para múltiplos de 1000; todas as versions incrementadas |

**RULE compliance checks (plugin):**

| RULE | Verificação | Método |
|---|---|---|
| RULE-01 | `manifest.json` contém `isDesktopOnly: true` | Inspeção direta |
| RULE-02 | Zero `addEventListener` / `setInterval` diretos | ESLint `eslint-plugin-obsidianmd` |
| RULE-03 | Zero `fs.*` no source do plugin | grep |
| RULE-04 | Zero `this.view` na classe Plugin | grep |
| RULE-05 | `onunload()` não chama `detachLeavesOfType` | grep + inspeção |
| RULE-06 | Zero `as TFile` / `as TFolder` | grep |
| RULE-07 | Zero hex hardcoded em `styles.css` | grep |
| RULE-08 | Comandos em sentence case, sem prefixo, sem hotkey | Command Palette |
| RULE-09 | Tab navigation + aria-labels + focus ring | Teste manual |
| RULE-10 | Desenvolvimento em vault de teste | Verificação de processo |

**Definition of Done:**
- Todos os 11 acceptance tests com status **pass** e evidência documentada
- Todos os 10 RULE checks com status **pass**
- Qualquer **fail** bloqueante corrigido e re-executado antes de fechar o sprint

**Testes:**
_(Os testes são os próprios itens AT-01 a AT-11 da tabela acima.)_

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:

---

### TASK-36: Produzir guia de integração para agentes

**Tipo:** `documentation`

**Descrição:**
Documentação técnica para desenvolvedores que precisam integrar um agente de IA ao ObsidianKanban MCP.

**Seções obrigatórias:**

**1. Transports disponíveis**
- `stdio`: agentes locais (processo filho do MCP)
- `HTTP+SSE`: agentes remotos. SSE endpoint para eventos em tempo real

**2. Autenticação**
- Header: `Authorization: Bearer <token>`
- Token obtido via CLI: `kanban-token create --project <id> --actor agent:<nome>`
- `project_id` vem do token — não enviar no payload

**3. Padrão recomendado de uso de `request_id`**
```
1. Antes de qualquer chamada mutante, gerar UUID v4 e armazenar
2. Enviar request_id em toda chamada mutante
3. Em caso de timeout ou erro de rede: retry com o mesmo request_id
4. Nunca reutilizar request_id para operações diferentes
```

**4. Tratamento de conflito (409)**
```
1. Receber 409 com current_card e conflicting_fields
2. Analisar: os campos que você queria mudar já foram alterados?
3. Reenviar com version de current_card e payload reconstruído
```

**5. Exemplo completo em TypeScript** — create → update → conflict handling

**Definition of Done:**
- Guia cobre os 4 tópicos acima
- Exemplo de código TypeScript funcional e testado
- Guia revisado por alguém que não participou da implementação

**Testes:**
- Seguir o guia do zero → conseguir criar e atualizar um card via MCP
- Simular conflito seguindo o guia → resolver com retry correto

**Execução** _(preencher ao concluir)_
- Agente:
- Input tokens:
- Output tokens:
- Observações:
