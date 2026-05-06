# 2. Goals and Non-Goals


### 2.1  Goals
- Agents write exclusively via MCP with scoped authorization, integer versioning, and idempotency.
- Humans use the Obsidian native editor freely. The system reconciles edits rather than preventing them.
- SQLite index provides fast, persistent, queryable card state without duplicating the source of truth.
- File watcher detects all external changes and enforces immutable-field invariants automatically.
- Complete audit trail for all mutations regardless of origin.
- Deterministic card ordering via position field.

### 2.2  Non-Goals (V1)
- Preventing humans from editing card files (not possible in Obsidian without removing vault access).
- Real-time collaboration, WebSockets, CRDTs.
- Mobile Obsidian support.
- Agent-to-agent communication through the board.
- External issue tracker integration.
- Multi-vault deployments.

