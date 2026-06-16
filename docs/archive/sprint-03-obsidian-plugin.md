# Architecture — Sprint 03 Obsidian Plugin

Reference for maintainers of the human-facing surface. Read
`sprint-02-core-mcp-api.md` first — the MCP tool contract, optimistic
locking, SSE bus, and audit/token_log invariants are taken for granted
here. This document covers the plugin runtime, the small server-side
changes that landed in Sprint 03, and the lifecycle/compliance choices
that satisfy the binding Obsidian rules (RULE-02..09) and the
acceptance criteria in TASK-17..32.

---

## 1. Scope

Sprint 03 ships the Obsidian Desktop plugin that consumes the MCP. It
also extends the server with one new tool and one new endpoint to
complete the round-trip with the plugin.

Plugin surface
- `KanbanBoardView` (ItemView, main area) — multi-project kanban with
  drag-and-drop, inline create, optimistic UI, live updates via SSE.
- `KanbanMetricsView` (ItemView, sidebar) — token consumption tables
  with date filters.
- Editor decorations — advisory banner on card `.md` files, plus a
  CSS rule that hides the Properties widget so the (long) frontmatter
  doesn't dominate the editor.
- Two commands: `open-kanban-board`, `show-metrics-panel`.
- Settings tab — base URL, bearer token (masked), project, plus a
  "Test connection" probe that hits `/health`.

Server additions
- `kanban_delete_card` — completes the CRUD; emits `CARD_DELETED`
  (previously declared in the type union but unreachable).
- `GET /metrics` — read-only aggregation over `token_log` for the
  metrics panel; loopback-only.
- `file_basename` column on `cards` + slug helpers — card files now
  live at `kanban-data/<project>/<title-slug>.md` instead of opaque
  `card-<nanoid>.md`.
- Storage moved from `.kanban-data/` (hidden, not indexed by Obsidian)
  to `kanban-data/` (visible, indexed). `.kanban/` still hidden for
  MCP internals.

Everything the agent-facing API guarantees in Sprint 02 still holds:
optimistic locking on `version`, atomic writes, audit + token_log
mirroring, SSE on every mutation, idempotency by `request_id`.

---

## 2. Module Map

```
plugin/
  manifest.json              — id, isDesktopOnly:true, minAppVersion 1.4.0
  tsconfig.json              — ES2018 target, lib DOM+ES2022, moduleResolution Bundler
  esbuild.config.mjs         — Bundles src/main.ts → CJS, copies manifest+styles
                               into OBSIDIANKAN_DEV_VAULT (default: ./test-vault)
  styles.css                 — Single sheet; every selector .kanban-mcp-*
  src/
    main.ts                  — KanbanPlugin extends Plugin; owns client +
                               SSESubscriber; routes SSE frames to open boards;
                               registers the two views, the settings tab, both
                               commands, and the file-open card-banner hook.
    settings.ts              — KanbanPluginSettings { baseUrl, token,
                               projectName }; DEFAULT_SETTINGS.
    settings-tab.ts          — PluginSettingTab using Obsidian Setting helpers;
                               saveSettings() rebuilds the client + subscriber
                               and refreshes any open board leaves.
    mcp/
      client.ts              — McpClient: http.request-based wrapper around the
                               6 MCP tools + /health + /metrics. Returns
                               McpResult<T> = ok | discriminated error.
      sse-subscriber.ts      — SSESubscriber: long-lived /events client over
                               http.request. Parses frames, tracks lastEventId,
                               reconnects with exponential backoff (cap 5s).
    view/
      board-view.ts          — KanbanBoardView (ItemView). Holds CardSummary[]
                               in memory; renders + delegates DnD/click/keydown;
                               applies SSE frames; routes errors to ConflictModal
                               or toasts.
      render.ts              — Pure DOM builders: groupBoard, renderBoard,
                               isOverdue, todayString. No view state.
      state.ts               — Pure helpers used by optimistic flows:
                               replaceCard, patchCard, appendCard, removeCard.
      metrics-view.ts        — KanbanMetricsView (ItemView). Sidebar leaf with
                               From/To date filters + Refresh button.
      metrics-render.ts      — Pure DOM builders: renderAllMetrics,
                               renderMetricsSummary, renderTable, formatInt,
                               lastDays.
    ui/
      conflict-modal.ts      — Modal for 409s. Keep mine / Use server.
      toast.ts               — showErrorToast (Notice 5s), showRetryToast
                               (Notice with a Retry button via DocumentFragment).
    editor/
      card-banner.ts         — workspace.on('file-open') hook: decorates card
                               files with a banner + a class that hides the
                               Properties widget.

src/                          (server-side additions)
  cards/
    slug.ts                  — slugifyTitle, uniqueBasename. Owns the
                               cross-platform/Obsidian filename ruleset.
  db/schema.ts               — cards.file_basename + (project,file_basename) index
  db/database.ts             — migrateAddFileBasename: idempotent ALTER + backfill
  services/
    card.ts                  — delete() added; create/update compute and pass
                               basenames; update supports rename via writer.
    metrics.ts               — MetricsService.collect(filter) — 5 grouped queries
                               + summary, with optional date range.
  server/http.ts             — GET /metrics handler, loopback-only check
  watcher/file-watcher.ts    — Resolves cards by frontmatter id (not filename);
                               detects user renames within a project.
  writer/atomic.ts           — write(card, body, basename, { previousBasename? }).
                               Rename = write new + unlink old.

scripts/
  dev-create-card.mjs        — Single create against a running MCP.
  dev-card-lifecycle.mjs     — create → move → update → delete with 500ms pauses.
                               Useful for eyeballing the board reacting to SSE.
  smoke-batch7..15.mjs       — Backend + plugin smokes for this sprint
                               (see §11 for the test matrix).
```

The plugin never touches Node `fs` (RULE-03). All disk access in
`kanban-data/` happens through the Obsidian Vault API (for opening the
file in the editor) or, transitively, through the MCP HTTP API.

---

## 3. Plugin Runtime

### 3.1 Object graph

```
Obsidian
   │
   ▼
KanbanPlugin (Component lifecycle)
   │
   ├─ McpClient                ← settings.{baseUrl, token}
   ├─ SSESubscriber            ← settings.baseUrl, onEvent → dispatch
   ├─ registerView(BOARD,   leaf → KanbanBoardView(leaf, plugin))
   ├─ registerView(METRICS, leaf → KanbanMetricsView(leaf, plugin))
   ├─ addSettingTab(KanbanSettingsTab)
   ├─ addCommand(open-kanban-board   → activateBoard)
   ├─ addCommand(show-metrics-panel  → activateMetrics)
   └─ registerCardBanner(this) — workspace.on('file-open')
```

`KanbanPlugin.client` and `KanbanPlugin.subscriber` are plain fields,
not Obsidian-managed objects. They're recreated on every `saveSettings`
and disposed via `this.register(() => subscriber?.stop())` so cleanup
ties to plugin unload.

Views are **never stored as fields on the plugin** (RULE-04). The
plugin reaches into them on-demand:

```ts
for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_KANBAN_BOARD)) {
  const view = leaf.view
  if (view instanceof KanbanBoardView) view.handleSseEvent(frame)
}
```

`onunload()` is a no-op (plus a comment) — it never calls
`detachLeavesOfType` (RULE-05). Obsidian restores the workspace on
reload; the plugin only registers new view factories.

### 3.2 Event lifecycle

Every event registration goes through Component lifecycle:

| Event source                | Registration                                       |
|-----------------------------|----------------------------------------------------|
| Workspace `file-open`       | `plugin.registerEvent(workspace.on('file-open'))`  |
| DOM events on the board     | `view.registerDomEvent(contentEl, 'click', …)` etc |
| DOM events in the modal     | Raw `addEventListener` (Modal isn't a Component;   |
|                             | listeners die with contentEl on close)             |
| SSE reconnect delay         | `setTimeout` in subscriber (cleared on `stop()`)   |
| Subscriber HTTP request     | `req.on('error' / 'timeout')` (cleared on stop)    |

No `window.addEventListener`, `document.addEventListener`, or direct
`setInterval` anywhere in `plugin/` (RULE-02 — verified by
`smoke-batch14.mjs`).

### 3.3 Connection status

The SSE subscriber emits `connecting | connected | disconnected`. Plugin
tracks the last value and dispatches `view.onConnectionStatusChange(status)`
to every open board, which repaints itself with an offline banner when
the status isn't `connected`. Backoff is capped at 5s so the banner
clears within a few seconds of the MCP coming back. Boards do **not**
re-fetch on the status change — the SSE reconnect already replays
missed events via `Last-Event-ID`; refetching would hammer a server
that's still warming up.

---

## 4. HTTP Client

`McpClient` wraps every MCP call so that **errors never throw**. The
caller always gets a discriminated result:

```ts
type McpResult<T> =
  | { ok: true;  data: T }
  | { ok: false; error: ConflictError | ValidationError | ServerError | OfflineError }
```

| HTTP status     | error.kind     | Notes                                           |
|-----------------|----------------|-------------------------------------------------|
| 200             | (ok)           |                                                 |
| 409             | `conflict`     | Carries `yourVersion`, `currentVersion`,        |
|                 |                | `conflictingFields`, `currentCard`.             |
| 400             | `validation`   | Carries `disallowedFields`, `allowedFields`.    |
| other non-200   | `server`       | Carries `status` + `message`/`error` from body. |
| transport error | `offline`      | Carries `message` (`mcp_unreachable` /          |
|                 |                | `timeout`) + `cause` (ECONNREFUSED, etc).       |

The client uses `node:http` directly — not the global `fetch` — because
the same module needs to be reusable from a future stdio MCP path
(Sprint 00 R-07). The subscriber follows the same constraint.

Token and baseUrl are captured at construction. `saveSettings()`
discards the instance and builds a fresh one.

---

## 5. SSE Subscriber

```
plugin           MCP
  │   GET /events (last-event-id?)
  ├───────────────►
  │              200 text/event-stream
  │◄──── id:42 event:CARD_MOVED data:{…}\n\n
  │       onEvent({id:42, type:'CARD_MOVED', data:{…}})
  │              (connection stays open …)
  │       … server dies, socket closes …
  │   setTimeout(connect, backoff)
  │   GET /events (last-event-id: 42)
  ├───────────────►
```

State machine

| Field             | Purpose                                          |
|-------------------|--------------------------------------------------|
| `stopped`         | True after `stop()` — gates reconnect attempts   |
| `req`, `res`      | Current http.request / IncomingMessage handles   |
| `buf`             | Trailing partial frame between `data` callbacks  |
| `lastEventId`     | Sent as `Last-Event-ID` on reconnect             |
| `reconnectTimer`  | Single setTimeout for the next attempt           |
| `currentBackoff`  | 1s → … → cap 5s (configurable for tests)         |

Reconnect is the only deferred work; `stop()` clears the timer and
destroys both `req` and `res`, so unload is instantaneous regardless
of connection state.

Plugin's `handleStatusChange` is debounced by the subscriber itself —
it only emits a status when it actually changes, so the board never
sees `connecting → connecting → …`.

---

## 6. Board View

### 6.1 State

```
private cards: CardSummary[]   // single source of truth for the rendered board
```

`refresh()` calls `client.listCards()` and replaces the array. Every
optimistic mutation takes a snapshot first, mutates locally, calls the
server, then either substitutes the server's authoritative copy on
success or restores the snapshot on error.

Rendering is fully pure — `renderBoard(container, cards, today,
forceProjects)`. Same input → same DOM. The view never mutates cards
in-place; helpers in `state.ts` (replaceCard / patchCard / appendCard /
removeCard) return new arrays so React-style reasoning applies.

### 6.2 Drag-and-drop

Delegation, not per-card listeners. Three handlers on `contentEl`:

```
dragstart → setData('text/x-kanban-mcp', cardId), add .dragging class
dragover  → preventDefault on .kanban-mcp-column, add .dragover highlight
dragleave → remove .dragover when actually leaving (relatedTarget check)
drop      → resolve target column, dispatch attemptMove
```

`attemptMove`:
1. Compare snapshot status — if same column, no-op.
2. Cross-project drop — Notice, no server call (UI shouldn't allow this
   but the guard is cheap).
3. Snapshot `this.cards`; patch optimistically with status + a
   sentinel `OPTIMISTIC_POSITION = MAX_SAFE_INTEGER` so the card lands
   at the bottom until the server response replaces it.
4. `client.moveCard(...)`; on ok, replace by id; on error, restore
   snapshot + route error (§7).

### 6.3 Create

The `+` button on each column header opens `CreateCardModal` (title
only). Submit triggers `attemptCreate(project, status, title)`:

1. Build a placeholder `CardSummary` with `id: card-optimistic-<ts>`,
   position = sentinel, status from the column, project from the
   column.
2. Snapshot + append placeholder.
3. `client.createCard(...)`. On ok, `removeCard(tempId) → replaceCard(server)`.
   On error, restore snapshot + route error.

`project` is always sent in the request. The server's CREATE allow-list
accepts it from both roles; for agents it must match `claims.project_id`
(else 400) — that asymmetry was widened in batch 4 specifically so the
plugin can send one shape regardless of role.

### 6.4 SSE → local state

```
case 'CARD_CREATED':
case 'CARD_UPDATED':
case 'CARD_HUMAN_EDITED':
   → refetchCard(payload.card_id) → replace or append
case 'CARD_MOVED':
   → patchCard(id, { status, position })
case 'CARD_REORDERED':
   → for each affected_cards[i] → patchCard(id, { position })
case 'CARD_DELETED':
   → removeCard(id)
```

Re-fetches for CREATE/UPDATE/HUMAN_EDITED are intentional — the SSE
payloads only carry identifiers, not the full card, so the only way to
get the latest title/priority/etc is `client.getCard(id)`. The board
re-renders after each application.

### 6.5 Opening a card .md

`kanban-data/` is now visible in the file explorer (`.kanban/` stays
hidden for internals), and Obsidian indexes its files. Single click on
a card resolves
`kanban-data/<project>/<card.file_basename ?? id>.md` via
`vault.getAbstractFileByPath`, narrows with `instanceof TFile` (RULE-06),
and `workspace.getLeaf(false).openFile(file)`. Enter/Space on a focused
card does the same — see §9.

---

## 7. Error UI

Every mutation funnels its error through `handleMutationError(error,
label, retry)`:

```
switch (error.kind) {
  case 'conflict':   ConflictModal(app, error, { keepMine: retry,
                                                 keepTheirs: () => refresh() })
  case 'validation': showErrorToast(`${label}: ${msg}${disallowedFields}`)
  case 'offline':    /* banner already visible — no toast */
  case 'server':     showRetryToast(`${label}: ${msg}`, retry)
}
```

`ConflictModal` shows `yourVersion / currentVersion`, the
`conflictingFields` list, and offers Keep mine (which is a closure that
re-issues the operation against `currentVersion`) or Use server (which
just discards the snapshot and refreshes from the server).

`showRetryToast` builds a `DocumentFragment` with a text span and a
Retry button, then constructs an Obsidian `Notice`. The button calls
`notice.hide()` then the retry closure. Notice doesn't expose buttons
natively, but it accepts a DocumentFragment as message — this is the
supported way.

Offline state is communicated by the banner at the top of the board
(driven by `plugin.connectionStatus`); toasting on every failed
mutation while offline would spam the user.

---

## 8. Filename strategy

The opaque `card-<nanoid>.md` filename made the file explorer
useless. Batch 6b moves to title-derived names while keeping `id` as
the canonical key.

```
id                ←→  immutable nanoid in frontmatter
file_basename     ←→  filesystem name (no .md), derived from title
```

`slugifyTitle(title)`:
- normalize NFKC
- strip cross-platform illegal chars: `/ \ : * ? " < > | # ^ [ ]`
  and control chars
- collapse whitespace
- truncate at 80 chars
- fall back to `"untitled"` if empty

`uniqueBasename(repo, project, slug, selfId?)`:
- if no existing card in the project has that basename, return it
- otherwise append `(2)`, `(3)`, … until free
- `selfId` lets a rename to the same effective name be a no-op (e.g.,
  re-saving without changing the title)

Where it's applied
- `CardService.create` computes the basename from the title before
  the first write.
- `CardService.update` recomputes only when the title changed; if the
  new basename differs from `row.file_basename`, `AtomicWriter.write`
  is called with `previousBasename` so the old `.md` is unlinked
  after the new one is durably committed.
- `CardService.move` and `reorder` reuse `row.file_basename` (and the
  per-neighbour basename in reorder); these operations never rename.
- `CardService.delete` uses `row.file_basename` to find the file to
  unlink.

Existing vaults
- `db/database.ts` runs `migrateAddFileBasename` on every open. It's
  idempotent: it checks `PRAGMA table_info(cards)` for the column,
  `ALTER TABLE ADD` if missing, then `UPDATE … SET file_basename = id
  WHERE file_basename = ''`. The `(project, file_basename)` index is
  created in the migration too (not in `SCHEMA_STATEMENTS`) so legacy
  DBs don't try to index a column that hasn't been added yet.
- Existing `card-<id>.md` files keep working — their basename is
  literally `card-<id>`, which is what the backfill sets.

File watcher
- `isCardFile` now accepts any `.md` not starting with `_`. Cards are
  identified by **frontmatter id**, not filename.
- A content-hash-equal event with a different basename is recognized
  as a user rename: SQLite updates, the old file is unlinked, no
  audit/SSE (no semantic field changed). This is the path that fires
  when the user renames a card in Obsidian's explorer.
- Cross-project moves still funnel through the EXTERNAL_MUTATION path.

Reconciliation (startup)
- Reads each `.md`, parses, matches by frontmatter id. Upserts when
  `file_hash` **or** `file_basename` drifts from the row.

---

## 9. Accessibility

Per RULE-09 and TASK-27, the plugin is keyboard-navigable and
screen-reader-readable:

| Element                   | A11y attributes                                       |
|---------------------------|-------------------------------------------------------|
| `.kanban-mcp-project`     | `role="region"` `aria-label="Project <name>"`         |
| `.kanban-mcp-column`      | `role="list"` `aria-label="<status> (<n> cards)"`     |
| `.kanban-mcp-card`        | `role="listitem"` `tabindex="0"` `draggable="true"`   |
|                           | `aria-label="<title>, priority …, due …, assigned …"` |
| `.kanban-mcp-column-add`  | `<button>` with `aria-label="Add card to <status>"`   |
| Metrics date inputs       | `<input type="date">` with `aria-label`               |
| Metrics tables            | Native `<table>` semantics                            |

Cards are openable from the keyboard: `onKeyDown` on `contentEl`
catches Enter or Space when the focused element is a card and calls
the same `openCardFile` as the click handler. Drag remains
pointer-only — keyboard "move card to next column" is a known follow-up
and is not in TASK-27's DoD.

Focus visibility is enforced in CSS:

```css
.kanban-mcp-card:focus-visible,
.kanban-mcp-conflict-buttons button:focus-visible,
.kanban-mcp-modal-buttons button:focus-visible {
  outline: 2px solid var(--interactive-accent);
  outline-offset: 1px;
}
```

`smoke-batch14.mjs` asserts these properties statically: no
`outline: none`, no hex colors, every selector under `.kanban-mcp-`,
tabindex+role+aria-label present in the bundle.

---

## 10. Editor decoration

When the active file is a `.md` whose name doesn't start with `_`
(currently the watcher's filter is broader; the banner is gated by
name + extension only for now), the file-open hook adds two things to
the markdown view's contentEl:

1. A `.kanban-mcp-card-banner` div above the editor — the advisory
   text the PRD requires.
2. A `.kanban-mcp-card-view` class on the contentEl. The stylesheet
   uses it to hide `.metadata-container` and `.metadata-properties`
   on that view only:

   ```css
   .kanban-mcp-card-view .metadata-container,
   .kanban-mcp-card-view .metadata-properties { display: none; }
   ```

`MarkdownView` instances are reused across files (Obsidian re-uses
contentEl). `clearStaleDecorations()` runs on every `file-open` and
strips the banner + class from every view before applying them to the
current one — otherwise switching from a card file to a regular note
would leave that note with the Properties widget hidden.

This is the cheapest path to the PRD's "frontmatter collapsed +
advisory banner" requirement: the raw YAML is still reachable via
Ctrl+E (source mode); the user just doesn't see the (very long)
Properties widget in live preview.

---

## 11. Test matrix

Smoke files are numbered continuously across sprints; this sprint
added batches 7..15.

| Smoke              | Surface                                  |
|--------------------|------------------------------------------|
| `smoke-batch7.mjs`  | `GET /metrics` (server) — empty state,  |
|                    | summary, all 5 groupings, date filters,  |
|                    | invalid date 400, no-auth required.      |
| `smoke-batch8.mjs`  | Plugin scaffold artifacts + McpClient   |
|                    | against a live MCP — 6 tools + health +  |
|                    | getMetrics + discriminated errors        |
|                    | (Conflict 409, Validation 400, Offline   |
|                    | via bogus port).                         |
| `smoke-batch9.mjs`  | Board read-only — groupBoard column      |
|                    | order, position sort, isOverdue, project |
|                    | isolation; bundle has view + command.    |
| `smoke-batch10.mjs` | Drag/create wiring in bundle + pure     |
|                    | state helpers (rollback preserves        |
|                    | ordering).                               |
| `smoke-batch11.mjs` | SSESubscriber against live MCP — status |
|                    | transitions, all 6 event types received  |
|                    | including CARD_DELETED, subscriber       |
|                    | restart, getCard fails post-delete.      |
| `smoke-batch12.mjs` | Bundle + styles for editor banner and   |
|                    | error UI (ConflictModal title, offline   |
|                    | banner, Retry button).                   |
| `smoke-batch13.mjs` | Filename refactor end-to-end — title →  |
|                    | basename, collision suffix, illegal char |
|                    | stripping, rename on update, move keeps  |
|                    | name, delete by basename, list exposes   |
|                    | file_basename, **user rename on disk**   |
|                    | picked up by the watcher.                |
| `smoke-batch14.mjs` | Static RULE audit (RULE-02..09) over    |
|                    | `plugin/src` and the built bundle.       |
| `smoke-batch15.mjs` | Metrics panel — bundle constants,       |
|                    | styles, pure render helpers              |
|                    | (formatInt, lastDays).                   |

The smokes that pre-date this sprint (3, 4, 5, 6) still pass after
the schema migration, the storage path rename, the additional tool,
and the filename refactor. `smoke-batch2.mjs` predates Node ESM's
strict `.ts` import resolution and has been broken independent of
this sprint's changes — not a regression here.

Dev helpers
- `scripts/dev-create-card.mjs` — single create against a running MCP.
- `scripts/dev-card-lifecycle.mjs` — full create → move → update →
  delete with 500ms pauses, intended for visually verifying the board
  reacts to SSE end-to-end inside Obsidian.

---

## 12. Known limitations / follow-ups

- **No keyboard drag.** Moving cards across columns requires a
  pointer. TASK-27 DoD covers focus + open via keyboard; cross-column
  move via keyboard is a v2 nice-to-have.
- **No frontmatter fold via CodeMirror.** The Properties widget hide
  covers the visual goal of TASK-28's "frontmatter colapsado", but
  doesn't programmatically fold the raw YAML in source mode. Obsidian
  doesn't expose a stable public API for it; CodeMirror is `external`
  in our esbuild config.
- **Migrations are inline.** Sprint 03 ships one migration
  (`migrateAddFileBasename`). Moving to a versioned migration registry
  with `PRAGMA user_version` is worth doing when the second migration
  lands.
- **CARD_DELETED on user OS deletion.** The watcher doesn't listen to
  `unlink` events. If the user deletes a card `.md` outside the
  plugin, the row stays in SQLite until the next startup
  reconciliation removes it as an orphan. No SSE event is fired in
  the interim.
- **Settings tab has no "test rename"-style validation** for the
  Project field. Typos won't surface until the first list/create
  call. Acceptable for v1.
- **stdio + HTTP simultaneously on the same vault is unvalidated.**
  Carried over from Sprint 02 §11. Plugin always uses HTTP, so no new
  pressure on this front.
