# 4. System Architecture


### 4.1  Component Responsibilities
| Component | Responsibility |
| --- | --- |
| MCP Server | Node.js daemon. Exclusive write path for agents. Owns the SQLite index. Runs the file watcher. Handles audit logging. Exposes stdio (local agents) and HTTP+SSE (remote agents and plugin Kanban board mutations). |
| SQLite Database | Persistent index stored at vault/.kanban/db.sqlite. Mirrors card frontmatter for fast queries. Source of truth remains the .md files — SQLite is a cache. Managed exclusively by MCP. |
| File Watcher | chokidar instance inside MCP. Monitors vault/kanban-data/**/*.md. On any change: parses frontmatter, validates invariants, reconciles SQLite, reverts illegal field changes, writes audit log. |
| Obsidian Plugin | TypeScript plugin inside Obsidian Desktop. Renders the Kanban board by querying MCP (list/get). Translates board interactions (drag, create) into MCP HTTP calls over localhost. Uses Node.js HTTP APIs — therefore manifest.json must declare isDesktopOnly: true. All Obsidian API interactions follow the binding implementation standards defined in §11.6. |
| Vault (Filesystem) | kanban-data/ holds the project folders and card .md files — visible in the Obsidian file explorer so the plugin can open cards in the editor. .kanban/ (hidden, dot-prefix) holds MCP internals that the user shouldn't touch. .md files in kanban-data/ are the source of truth; SQLite is derived from them and always reconcilable. |
| Audit Log | Append-only NDJSON at vault/.kanban/audit.ndjson. Written by MCP for every mutation of any origin. |

```mermaid
graph LR
    subgraph Clients["Clients"]
        AGT["AI Agent"]
        HUM["Human (Manager)"]
    end

    subgraph OBS["Obsidian Desktop"]
        PLUGIN["Plugin\n(board UI)"]
        EDITOR["Editor\n(direct .md edit)"]
    end

    subgraph MCP_SRV["MCP Server (Node.js daemon)"]
        MCP["MCP Core\nvalidation · idempotency · audit"]
        FW["File Watcher\nchokidar · 500ms debounce"]
    end

    subgraph VAULT["Vault (filesystem)"]
        MD["kanban-data/\n*.md  ← source of truth"]
        SQLITE[(".kanban/db.sqlite\ncache / index")]
        AUDIT[".kanban/audit.ndjson"]
        IDEM[".kanban/idempotency.json"]
    end

    AGT -->|"stdio / HTTP+SSE"| MCP
    HUM -->|"drag · create · move"| PLUGIN
    HUM -->|"direct file edit"| EDITOR
    PLUGIN -->|"HTTP :localhost\n(all mutations)"| MCP
    EDITOR -->|"writes"| MD

    MCP -->|"atomic write (.tmp → rename)"| MD
    MCP -->|"transaction"| SQLITE
    MCP -->|"append"| AUDIT
    MCP -->|"persist"| IDEM

    MD -. "change event" .-> FW
    FW -->|"reconcile + rewrite"| MD
    FW -->|"update"| SQLITE
    FW -->|"append"| AUDIT

    MCP -. "list queries" .-> SQLITE
    MCP -. "get_card reads body" .-> MD
```

### 4.2  Write Path Diagram

```mermaid
flowchart TD
    AGT["Agent"]
    HB["Human via Plugin Board"]
    HD["Human via Obsidian Editor"]

    AGT -->|"stdio / HTTP+SSE"| MCP
    HB -->|"HTTP POST :localhost"| MCP
    HD -->|"direct file edit"| MD

    MCP["MCP Server\nvalidate · idempotency check · process"]

    MCP --> ATOMIC

    subgraph ATOMIC["Atomic Write — see §7.4"]
        W1["set MCP-originated flag"] --> W2["write .md.tmp + fsync"]
        W2 --> W3["rename → .md"]
        W3 --> W4["SQLite transaction"]
        W4 --> W5["clear flag · append audit log"]
    end

    W3 --> MD[".md File\n(source of truth)"]
    W4 --> DB[("SQLite\n(cache)")]

    MD -. "chokidar detects ALL .md changes" .-> FW_CHK

    FW_CHK{"MCP-originated?"}
    FW_CHK -->|"yes"| SKIP["skip — already processed"]
    FW_CHK -->|"no (human edit)"| FW["File Watcher processes\nsee §4.3"]
    FW --> MD
    FW --> DB
    FW --> AUDIT["audit.ndjson"]
    W5 --> AUDIT
```

### 4.3  File Watcher Reconciliation Logic
The file watcher is the central safety mechanism for human direct edits. Its processing pipeline on every file change event:

```mermaid
flowchart TD
    START(["file change detected"]) --> DEB["wait 500ms debounce\n(per file)"]
    DEB --> ORIG{"MCP-originated\nflag set?"}
    ORIG -->|"yes"| SKIP(["skip — already processed by MCP"])
    ORIG -->|"no"| PARSE["parse frontmatter"]

    PARSE --> PFAIL{"parse\nfailed?"}
    PFAIL -->|"yes"| RALL["revert entire file to\nlast SQLite-known good state\nlog PARSE_ERROR"]
    RALL --> DONE(["done"])

    PFAIL -->|"no"| IMM{"immutable fields\naltered?"}
    IMM -->|"yes"| RIMM["revert those fields\nlog FIELD_REVERTED per field"]
    RIMM --> MUT
    IMM -->|"no"| MUT{"mutable fields\nvalid?"}

    MUT -->|"invalid"| RMUT["revert invalid fields only\nlog FIELD_REVERTED"]
    RMUT --> APPLY
    MUT -->|"valid"| APPLY

    APPLY["increment version\nset updated_at = now\nset updated_by = 'human:manager'\natomic rewrite (.tmp → .md)"]
    APPLY --> SQLU["update SQLite index"]
    SQLU --> ALOG["append HUMAN_EDIT to audit log"]
    ALOG --> DONE2(["done"])
```

**File deletion (unlink events):** when a `.md` file is deleted by a manager, chokidar emits an `unlink` event — distinct from the `change` event pipeline above. The file watcher removes the corresponding SQLite row, emits `CARD_DELETED` to the SSE event bus (§6.10), and appends a `CARD_DELETED` entry to the audit log. No revert is attempted — manager deletion is intentional.

### 4.4  SQLite vs .md Files — Relationship
| The .md files are the source of truth. SQLite is a derived, always-reconcilable cache.  If SQLite is deleted: MCP rebuilds it from .md files on next startup. If SQLite and .md diverge (e.g. after a crash mid-write): MCP resolves by trusting the .md file. SQLite is never written to without also writing (or having just written) the corresponding .md file. SQLite does not store card body text — only frontmatter fields needed for queries and the board render. |
| --- |

### 4.5  Vault Directory Structure
| vault/   kanban-data/                    ← Visible in Obsidian explorer (no dot-prefix)     projeto-x/       _meta.json                   ← Project metadata, agent token hashes, column config       card-abc123.md       card-def456.md     projeto-y/       _meta.json       card-ghi789.md   .kanban/                         ← MCP internal data (hidden)     db.sqlite                      ← SQLite index     audit.ndjson                   ← Append-only audit log     idempotency.json               ← request_id deduplication store     manager-tokens.json            ← Vault-level manager token hashes (no project_id)   (normal Obsidian notes here...)  ← User's vault, unaffected |
| --- |

### 4.6  MCP Server Internal Module Architecture

```mermaid
graph TD
    subgraph Entry["Entry Points"]
        STDIO["stdio transport\n(local agents)"]
        HTTP_T["HTTP+SSE transport\n(plugin + remote agents)"]
    end

    subgraph Core["MCP Core"]
        ROUTER["Request Router\n(tool dispatch)"]
        TOKEN_VAL["Token Validator\nproject_id + role — §3.2"]
        IDEM_CHK["Idempotency Checker\nrequest_id dedup"]
    end

    subgraph Services["Services"]
        CARD_SVC["Card Service\ncreate · update · move · reorder"]
        QUERY_SVC["Query Service\nlist · get"]
        RECON_SVC["Reconciliation Service\nstartup scan — §9.5"]
    end

    subgraph Infra["Infrastructure"]
        SQLITE["SQLite Repository\nindex reads + writes"]
        FILE_IO["File I/O\natomic .tmp → rename — §7.4"]
        AUDIT_LOG["Audit Logger\naudit.ndjson"]
        FW_SVC["File Watcher\nchokidar · 500ms debounce — §4.3"]
        SSE_BUS["SSE Event Bus\npush updates to plugin"]
        IDEM_STORE["Idempotency Store\n.kanban/idempotency.json"]
    end

    STDIO --> ROUTER
    HTTP_T --> ROUTER
    ROUTER --> TOKEN_VAL --> IDEM_CHK

    IDEM_CHK --> CARD_SVC
    IDEM_CHK --> QUERY_SVC

    CARD_SVC --> FILE_IO
    CARD_SVC --> SQLITE
    CARD_SVC --> AUDIT_LOG
    CARD_SVC --> SSE_BUS
    CARD_SVC --> IDEM_STORE

    QUERY_SVC --> SQLITE
    QUERY_SVC --> FILE_IO

    FW_SVC -->|"human edit detected"| CARD_SVC
    RECON_SVC --> SQLITE
    RECON_SVC --> FILE_IO
```

