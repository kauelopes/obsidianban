# 14. Definition of Done


### 14.1  MCP Server + File Watcher
- All 6 tools correct for valid inputs.
- Agent token for Project X receives 404 on any Project Y card.
- Stale version → 409 with current_card populated.
- Disallowed field → 400 with disallowed_fields list.
- Duplicate request_id within 24h → identical response, no duplicate .md file.
- Kill -9 during write → no corrupted .md (only .tmp at worst). Startup cleans .tmp.
- Human changes id field directly → reverted within 600ms. FIELD_REVERTED in audit log. Editable fields in same save preserved.
- Human corrupts frontmatter → reverted to last good state within 600ms. PARSE_ERROR logged.
- SQLite deleted → startup rebuilds correctly from .md files. All cards queryable after rebuild.
- Every mutation (any origin) produces an audit log entry with correct op, actor, version.

### 14.2  Obsidian Plugin
- Board renders correctly, cards ordered by position field.
- Drag-and-drop calls MCP HTTP — confirmed via network log. No direct file writes.
- Card file opened in Obsidian shows collapsed frontmatter and advisory banner.
- Conflict overlay on 409. Error toasts on 400/500. Offline banner when MCP unreachable.
- Board updates within 500ms of any card change via MCP SSE stream.

| RULE compliance checks (§11.6) — verified before Milestone 2 sign-off:  RULE-01: manifest.json contains isDesktopOnly: true. RULE-02: ESLint (eslint-plugin-obsidianmd) reports zero addEventListener / setInterval violations. All event refs go through registerEvent / registerDomEvent / registerInterval. RULE-03: No fs.* calls anywhere in plugin source. Vault reads use Vault.process(). Deletions use FileManager.trashFile(). RULE-04: No KanbanView (or any view) stored as a Plugin class field. Grep for 'this.view' returns zero results in plugin class. RULE-05: onunload() does not call detachLeavesOfType(). RULE-06: No 'as TFile' or 'as TFolder' type assertions. All narrowing uses instanceof. RULE-07: No hardcoded hex colours in styles.css. All colour properties use var(--...). CSS selectors all begin with .kanban-mcp-. RULE-08: All command IDs lowercase hyphenated, no plugin name prefix, no 'command' suffix. No default hotkeys defined. RULE-09: All buttons have aria-label. Tab navigation reaches all interactive elements. Focus ring visible. RULE-10: Development was performed in the dedicated test vault, not a personal vault. |
| --- |

### 14.3  End-to-End Acceptance Tests
- Agent B requests Project A card → 404.
- Agent A creates card with request_id. Retries. Single .md file, identical responses.
- Agent A calls update with owner field → 400 disallowed_fields=["owner"].
- Agent A moves card with correct version → version+1, MOVE in audit log.
- Agent A moves card with stale version → 409 with current_card.
- Human opens card, changes id in frontmatter, saves → id reverted within 600ms, body edits preserved, FIELD_REVERTED in audit log.
- Human corrupts frontmatter (delete --- separator) → file reverted within 600ms, PARSE_ERROR logged.
- External sync write simulation → EXTERNAL_MUTATION logged within 200ms. Agent's next write → 409.
- Delete SQLite. Restart MCP. All cards queryable immediately. Audit log: SQLITE_REBUILT.
- Agent and human concurrent edit → human's edit applied on top of agent's as separate version. Both changes preserved where fields don't overlap.
- Reorder 5 cards → positions normalized to multiples of 1000. All affected versions incremented.

