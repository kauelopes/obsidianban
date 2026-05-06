# 1. Product Overview


### 1.1  What Is the System
ObsidianKanban MCP is a project management system built on an Obsidian vault. Cards are Markdown files. AI agents interact exclusively through the MCP server. Humans interact through the Obsidian UI — either through the plugin's Kanban board or by editing card files directly in the Obsidian editor. A file watcher reconciles all human edits, enforcing invariants and maintaining a SQLite index.

### 1.2  The Two Write Paths
| Agents: MCP is the only permitted write path. No exceptions. Humans: may write via the plugin Kanban UI (which calls MCP) or directly in the Obsidian editor. The file watcher detects and reconciles direct edits within ~100ms. |
| --- |
This design deliberately avoids building a custom card editor inside the plugin. Obsidian's native editor is already excellent. The system embraces it and adds a reconciliation layer on top.

### 1.3  Key Differentiators
| Differentiator | Description |
| --- | --- |
| Two-path write model | Agents: MCP only. Humans: native Obsidian editor + file watcher reconciliation. No custom card editor needed. |
| SQLite index | Persistent, queryable index alongside .md files. Zero external dependencies. Startup is instantaneous from existing DB. |
| Immutable-field protection | File watcher detects and reverts changes to system-managed fields within ~100ms, preserving human's content edits. |
| Uniform agent concurrency | All agent writes use integer version via MCP. Conflict detection is explicit and deterministic. |
| Full audit coverage | All mutations — MCP writes, human direct edits, external sync, field reversions — produce audit log entries. |
| Idempotent agent writes | request_id enables safe agent retries without duplicate card creation. |

