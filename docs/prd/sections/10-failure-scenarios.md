# 10. Failure Scenarios

| Scenario | System Response | Recovery |
| --- | --- | --- |
| Agent version conflict | 409 with current_card | Agent merges, retries with new version. |
| Disallowed field in MCP request | 400 with disallowed_fields | Agent removes fields and retries. |
| Human changes immutable field | Watcher reverts field(s), preserves rest. FIELD_REVERTED logged. | Transparent to human. File corrected within ~500ms + debounce. |
| Human corrupts frontmatter (invalid YAML) | Watcher reverts entire file to last SQLite state + stored body. PARSE_ERROR logged. | File restored within ~600ms. Human's body edits since last version are lost. |
| Human sets invalid status | Watcher reverts status field only. Other changes preserved. FIELD_REVERTED logged. | Transparent. File corrected within ~600ms. |
| Disk full during watcher revert | Revert write fails. MCP logs REVERT_FAILED. File remains in bad state. | Operator must manually restore. MCP continues serving other cards normally. |
| SQLite corrupted / deleted | MCP detects on startup. Deletes and rebuilds from .md files. SQLITE_REBUILT logged. | Rebuild takes O(n) time proportional to card count. Normal operation resumes. |
| MCP crash during write | .tmp may remain. Deleted on next startup. SQLite may be 1 version behind .md. | Startup reconciliation detects hash mismatch and corrects SQLite. |
| Duplicate request_id | Cached response returned. No re-execution. | Transparent to agent. |
| MCP offline (plugin) | Plugin shows read-only banner. Board still displays from last state. | MCP health polling every 5s. Banner removed on reconnect. |
| External sync pushes card file | Watcher fires. Processes as human edit path: validates, reconciles, logs EXTERNAL_MUTATION. | Version incremented. Any in-flight agent write → 409. |

