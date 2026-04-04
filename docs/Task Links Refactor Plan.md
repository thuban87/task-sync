# Task Links Refactor Plan

## Overview

Evolve the Task Sync plugin from a single-purpose priority task scanner into a multi-connection "Task Links" system. The plugin will support multiple independent sync connections to the daily note, each with its own section, settings, and bidirectional sync.

### Connection Types

1. **Priority Scan** (built-in) — The existing vault-wide scan for tasks marked with priority emojis (⏫/🔺). This becomes the first, default TaskLink.
2. **Note Mirror** (user-added) — Mirrors tasks from a specific source note into a section on the daily note. Supports filtering by section, tags, and exclude emoji. Users can add as many of these as they want.

### Motivation

The current plugin only syncs high-priority tasks found anywhere in the vault. The user also has specific notes (e.g., a homework task list) that should be mirrored to the daily note. Rather than hard-coding each new sync type, we generalize the plugin into a framework where any number of sync connections can be configured.

---

## Data Model

### SyncableTask (shared task interface)

The current `PriorityTask` interface is renamed to `SyncableTask` to reflect that both connection types produce tasks through the same pipeline. Priority becomes optional since note-mirror tasks have no priority level, and `linkId` is added so downstream services always know which connection a task belongs to.

```ts
/**
 * A task that can be synced to the daily note.
 * Used by both priority-scan and note-mirror connections.
 */
interface SyncableTask {
  /** The full raw text of the task line found in the source */
  originalLine: string;

  /**
   * Display/matching text.
   * - Priority-scan: aggressively cleaned (stripped of checkboxes, priority markers, wikilinks, metadata).
   * - Note-mirror: lightly cleaned (checkbox prefix stripped only). Preserves tags, dates, and other content.
   */
  displayText: string;

  /** Path to source file (relative to vault root) */
  filePath: string;

  /** Line number in source file (0-indexed) */
  lineNumber: number;

  /** Priority level. Present for priority-scan tasks, absent for note-mirror tasks. */
  priority?: 'highest' | 'high';

  /** ID of the TaskLink connection that produced this task */
  linkId: string;
}
```

**Migration note**: All existing references to `PriorityTask` are updated to `SyncableTask`. The `cleanText` field is renamed to `displayText` to better reflect its dual purpose (display on daily note + matching key). The existing `TaskParser.cleanTaskText()` continues to be used for priority-scan tasks; a new lightweight `TaskParser.trimCheckbox()` is used for note-mirror tasks.

### TaskLink (Discriminated Union)

```ts
interface TaskLinkBase {
  id: string;
  type: 'priority-scan' | 'note-mirror';
  enabled: boolean;
  sectionHeader: string;              // MUST be a ## level header. e.g. "## High Priority Tasks" or "## Homework"
  taskLimit: number;                  // 0 = unlimited
  collapsible: boolean;               // render section as an Obsidian callout
  enableBidirectionalSync: boolean;   // two-way checkbox sync for this connection
}

interface PriorityScanLink extends TaskLinkBase {
  type: 'priority-scan';
  includeHighest: boolean;            // sync ⏫ tasks
  includeHigh: boolean;               // sync 🔺 tasks
  excludedFolders: string[];
  excludedFiles: string[];
  excludedFileNames: string[];
}

interface NoteMirrorLink extends TaskLinkBase {
  type: 'note-mirror';
  sourceNotePath: string;             // path to the note to mirror
  sourceSections: string[];           // which sections to pull from (empty = all)
  excludeEmoji: string;               // emoji that opts a task OUT of sync (e.g. 🚫)
  includeCompleted: boolean;          // whether to sync completed tasks
  filterTags: string[];               // only sync tasks with these tags (empty = no filter)
}

type TaskLink = PriorityScanLink | NoteMirrorLink;
```

### Updated PluginSettings

```ts
interface PluginSettings {
  settingsVersion: number;            // for migration detection
  enabled: boolean;                   // global enable/disable
  debounceMs: number;                 // global debounce delay
  enableDebugLogging: boolean;        // global debug toggle
  taskLinks: TaskLink[];              // array of sync connections
}
```

The existing flat settings (sectionHeader, taskLimit, includeHighest, etc.) are migrated into `taskLinks[0]` as a `PriorityScanLink`.

---

## Phase 1 — Data Model and Settings Migration

**Goal**: Introduce the TaskLink data model, rename PriorityTask to SyncableTask, migrate existing settings, and update internal references — with zero behavioral changes.

**Files**:
- **NEW** `src/models/TaskLink.ts` — Define `TaskLinkBase`, `PriorityScanLink`, `NoteMirrorLink`, `TaskLink` types. Include `generateId()` helper and `DEFAULT_PRIORITY_SCAN_LINK` / `DEFAULT_NOTE_MIRROR_LINK` constants.
- **RENAME** `src/models/PriorityTask.ts` → `src/models/SyncableTask.ts` — Rename `PriorityTask` to `SyncableTask`. Make `priority` optional. Add `linkId: string`. Rename `cleanText` to `displayText`. Keep `SyncedTask` and `CheckboxState` interfaces in this file (updated to use `displayText` where applicable).
- **MODIFY** `src/settings.ts` — New `PluginSettings` interface with `taskLinks[]`. Add `migrateSettings(data: any): PluginSettings` that detects old flat format (no `taskLinks` field) and converts to new format. Settings UI temporarily reads/writes from `taskLinks[0]`.
- **MODIFY** `main.ts` — `loadSettings()` calls `migrateSettings()`. All existing `this.settings.sectionHeader` etc. reads point to `this.settings.taskLinks[0]`. Update all `PriorityTask` imports to `SyncableTask`.
- **MODIFY** all service files and `TaskParser.ts` — Update `PriorityTask` references to `SyncableTask`, `cleanText` to `displayText`.

**Validation**: Build and run. Existing users' settings are transparently migrated. Plugin behaves identically.

---

## Phase 2 — DailyNoteService Multi-Section Support

**Goal**: Make DailyNoteService section-aware so it can manage multiple independent sections on the daily note.

**Files**:
- **MODIFY** `src/services/DailyNoteService.ts`:
  - `appendNewTasks(dailyNote, tasks, link)` — takes a `TaskLink` for section header, collapsible flag, task limit. Returns 0 if the section header is not found in the daily note (no auto-creation of sections).
  - `readExistingTasks(dailyNote, sectionHeader, collapsible)` — scoped to a specific section.
  - `findSectionInsertPoint(content, sectionHeader, collapsible)` — handles both plain headers and callout headers. Returns `null` if header not found.
  - `formatTask(task, dailyNote, link)` — link-type-aware formatting:
    - **Priority-scan**: `- [ ] {displayText} {priorityEmoji} {wikilink}` (current behavior — wikilink to source file since tasks come from many files)
    - **Note-mirror**: `- [ ] {displayText}` (raw task text with checkbox prefix stripped, no wikilink — source note reference lives in the link config and optionally in the user's section header)
  - Remove direct `this.settings.sectionHeader` reads; everything comes from the `link` parameter.
- **MODIFY** `main.ts` — Pass `taskLinks[0]` to `dailyNoteService.appendNewTasks()`.

**Section header behavior**: The plugin only syncs to a section if the header already exists in the daily note. If the header is not found, that link is silently skipped. This gives the user full control over section placement and ordering — they put headers in their daily note template wherever they want.

**Section header constraints**:
- Section headers MUST be `##` level. The settings UI enforces this (see Phase 6).
- This simplifies `findSectionBoundaries` and `findSectionInsertPoint`: a section starts at its `##` header line and ends at the next line starting with `#` or `##` (any heading of level 1 or 2), or EOF. Nested `###` and below are considered content within the section and do not break the boundary.
- Section headers must be unique across all links (enforced in Phase 6).

**Validation**: Build and run. Behavior identical, but the service is now parameterized.

---

## Phase 3 — Note Mirror Scanner Service

**Goal**: Create the scanning logic for Note Mirror connections. Can be built in parallel with Phase 2.

**Files**:
- **NEW** `src/services/NoteMirrorScannerService.ts`:
  - `scanSourceNote(link: NoteMirrorLink): Promise<SyncableTask[]>`
  - Opens the source file via `vault.cachedRead()` (uses Obsidian's in-memory cache, avoids disk I/O). Optionally uses `metadataCache.getFileCache(file).listItems` as a fast bail-out — if the source note has no list items at all, skip the read entirely.
  - Parses content by section headers.
  - Filters to `link.sourceSections` (or all if empty).
  - Collects all checkbox lines from matching sections.
  - Excludes tasks containing `link.excludeEmoji`.
  - Filters by `link.filterTags` (if any).
  - Excludes completed tasks unless `link.includeCompleted` is true. Note: this only controls whether completed tasks are *added* to the daily note. The plugin never removes tasks from the daily note (see Architectural Decisions: "Append-only daily note" invariant).
  - Produces `SyncableTask` objects with:
    - `displayText`: lightly cleaned via `TaskParser.trimCheckbox(line)` — only strips the `- [ ]` / `- [x]` prefix. Preserves tags, dates, emojis, and all other content.
    - `lineNumber`: preserved from source file (used as a matching signal for bidirectional sync).
    - `filePath`: set to `link.sourceNotePath`.
    - `linkId`: set to `link.id`.
    - `priority`: omitted (undefined).
- **MODIFY** `src/utils/TaskParser.ts`:
  - Add `trimCheckbox(line): string` — strips only the checkbox prefix (`- [ ] ` or `- [x] `), preserving everything else. Used for note-mirror display text.
  - Add `extractTags(line): string[]` and `containsEmoji(line, emoji): boolean` helpers.
- **MODIFY** `src/constants.ts` — Add `TAG_REGEX`.

**Matching strategy for note-mirror tasks**: Since all tasks in a mirror come from one known source file, matching uses a text-first approach:
1. **displayText is the primary match key** — the lightly-cleaned task text (checkbox prefix stripped). This is the strongest signal because it survives line number shifts caused by inserting or removing tasks above.
2. **Source file path** — always known from `link.sourceNotePath`, not extracted from the task line.
3. **Line number is a tie-breaker only** — used when two tasks in the same source note have identical `displayText` (e.g., two `- [ ] Review notes` items). In that case, closest line number wins. Line numbers shift on any edit above, so they must never be the primary signal.

The matching algorithm: search the source file for all tasks whose `displayText` matches. If exactly one match is found, that's the target. If multiple matches are found (identical task text), use line number proximity as a tie-breaker to pick the closest one.

**Validation**: Service can be instantiated and called against a test note. Verify that inserting a task at the top of the source note does not break matching for tasks below it.

---

## Phase 4 — FileWatcher Refactor

**Goal**: Route file changes to the correct sync handler based on which TaskLinks are affected. Also handle source note rename/delete events.

**Current behavior**: FileWatcherService triggers `syncPriorityTasks()` on any vault file change.

**New behavior**:
- Priority-scan links: trigger on any non-excluded, non-daily-note file change (current behavior).
- Note-mirror links: trigger only when their specific `sourceNotePath` changes.

**Files**:
- **MODIFY** `src/services/FileWatcherService.ts`:
  - Accept `taskLinks` reference so it can determine which links are affected.
  - Track `pendingLinkIds: Set<string>` during debounce window.
  - On timer fire, call `onSync(file, matchingLinkIds)`.
- **MODIFY** `main.ts`:
  - New `syncNoteMirror(linkId)` method using `NoteMirrorScannerService` + `DailyNoteService.appendNewTasks()`.
  - Updated callback dispatches to the right sync method based on link IDs.
  - **Register vault `rename` event handler**: When a file is renamed/moved, find any note-mirror links whose `sourceNotePath` matches the old path. Update `sourceNotePath` to the new path and save settings. Log the change.
  - **Register vault `delete` event handler**: When a file is deleted, find any note-mirror links whose `sourceNotePath` matches. Set `enabled: false` on those links, save settings, and show a `Notice` informing the user (e.g., "Task Links: Disabled mirror for 'Homework' — source note was deleted").
  - **Introduce shared processing guard** (`pluginModifiedFiles: Set<string>`): A centralized set of file paths currently being modified by the plugin, stored on the plugin instance in `main.ts` and passed to all sync services during construction. Before any service writes to a file via `vault.modify()`, it adds the file path to this set. After the write completes, it removes the path after a short delay (~100ms) to account for Obsidian's async `vault.on('modify')` event firing. When any service's file watcher fires for a file in this set, it skips processing. This replaces the per-service `isProcessing` booleans and prevents bidirectional sync ping-pong loops where ReverseSyncService writes to a source file, triggering SourceToDailySyncService, which writes back to the daily note, triggering ReverseSyncService again.

**Validation**: Priority scan still triggers on vault changes. Note mirror triggers only on source note changes. Renaming a source note updates the link config. Deleting a source note disables the link with a notice. Checking a task in the daily note syncs to source without triggering a bounce-back.

---

## Phase 5 — Bidirectional Sync for Multiple Connections

**Goal**: Make ReverseSyncService and SourceToDailySyncService handle multiple connections, each scoped to its own section. This phase is a **hard dependency** for note-mirror reverse sync — without section scoping, the plugin cannot determine where to sync mirrored tasks back to (since they have no wikilinks).

### Why section scoping is required

Priority-scan tasks carry a wikilink to their source file, so `ReverseSyncService` can find the source from the task line itself. Note-mirror tasks do **not** have wikilinks — their source is the `sourceNotePath` stored in the link config. The only way to connect a daily note task back to its source is to determine which section it's in, look up the TaskLink that owns that section, and use that link's config to find the source.

**Files**:
- **MODIFY** `src/services/DailyNoteService.ts` — Add `findSectionBoundaries(content, links): Map<string, { start, end }>` returning line ranges per link ID. Boundary rules: a section starts at its `##` header line and ends at the next `#` or `##` header (level 1 or 2), or EOF. Nested `###` and below are content within the section, not boundaries. This is consistent with the header level constraint defined in Phase 2.
- **MODIFY** `src/services/ReverseSyncService.ts`:
  - `startWatching(dailyNote, links: TaskLink[])` — receives all active links.
  - On daily note modification:
    1. Compute section boundaries for all links.
    2. For each changed task, determine which section it falls in.
    3. If the owning link has `enableBidirectionalSync: false`, skip it.
    4. For **priority-scan** tasks: use the wikilink in the task line to find the source file (current behavior).
    5. For **note-mirror** tasks: use the owning link's `sourceNotePath` as the source file. Match using `displayText` as the primary key; use `lineNumber` as a tie-breaker only if multiple tasks in the source have identical text.
  - Tasks that fall outside any known TaskLink section are ignored by reverse sync.
- **MODIFY** `src/services/SourceToDailySyncService.ts`:
  - `startWatching(dailyNote, links: TaskLink[])` — receives all active links.
  - **Cache now tracks link metadata**: Change cache type from `Map<string, { sourcePath, checked }>` to `Map<string, { sourcePath, checked, linkId, linkType }>`. This allows the service to know how to match each task in the source file.
  - When scanning a source file for changes:
    - For tasks with `linkType: 'priority-scan'`: require priority emoji match (current behavior via `TaskParser.extractPriority()`).
    - For tasks with `linkType: 'note-mirror'`: skip the priority emoji check entirely. Match using `displayText` as primary key; `lineNumber` as tie-breaker for duplicate text only.
  - Source for note-mirror tasks is the specific `sourceNotePath` from the link config.

**Matching strategy by link type**:
| Signal | Priority-scan | Note-mirror |
|--------|--------------|-------------|
| displayText | Primary match key (aggressively cleaned) | Primary match key (lightly cleaned) |
| lineNumber in source | Weak signal (vault-wide) | Tie-breaker only (for duplicate text) |
| Source file path | From wikilink in task line | From link config (`sourceNotePath`) |
| Priority emoji | Required in source | Not checked |

**Validation**: Check/uncheck in priority section syncs to source. Check/uncheck in note-mirror section syncs to source note. Check in source note syncs to daily note. Verify no ping-pong: a single checkbox toggle should result in exactly one sync in each direction, not an infinite loop. The shared processing guard from Phase 4 handles this.

---

## Phase 6 — Settings UI

**Goal**: Full settings panel with collapsible sections per connection and add/remove functionality.

**Files**:
- **MODIFY** `src/settings.ts` — Overhaul `TaskSyncSettingTab.display()`:
  - **Global settings** at top: enabled, debounce delay, debug logging.
  - **Task Links section**: Each `taskLinks[i]` renders in a collapsible `<details>` element.
  - Per-link settings:
    - Enabled toggle
    - Section header text input (user-defined string — can be plain text like `## Homework` or include wikilinks/emojis at the user's discretion)
    - Task limit
    - Collapsible toggle
    - Bidirectional sync toggle
    - **Priority-scan specific**: priority filter toggles, exclusion lists
    - **Note-mirror specific**: source note path (file picker with autocomplete), source sections (multi-input), exclude emoji, include completed toggle, filter tags
  - "Add Note Mirror" button at the bottom.
  - "Remove" button on each note-mirror link (priority-scan cannot be removed).
  - **Section header validation** (hard enforcement, not just warnings):
    - **Uniqueness**: No two links may share the same `sectionHeader`. If a duplicate is detected, show an error and prevent saving until resolved.
    - **Header level**: Section headers must be `##` level (e.g., `## Homework`, not `### Homework` or `# Homework`). The UI should auto-prepend `## ` if the user omits it, or validate and show an error. This constraint simplifies section boundary detection — see Phase 2.
- **MODIFY** `main.ts`:
  - Add `restartServices()` that calls `stopServices()` then `startServices()`, followed by `syncAllLinks()`. This ensures that adding a new link mid-session immediately syncs it, and changing settings takes effect without restarting the plugin.

**Validation**: Add a note-mirror in settings, see it appear. Remove it. Change settings. Verify services restart cleanly and new links sync immediately.

---

## Phase 7 — Daily Note Creation and Full Sync

**Goal**: When the daily note is created or plugin loads, sync ALL enabled connections.

**Files**:
- **MODIFY** `main.ts`:
  - Add `syncAllLinks()` that iterates all enabled task links **sequentially** (one at a time, awaiting each before starting the next) and calls the appropriate sync method for each. Sequential execution prevents write conflicts — multiple links writing to the same daily note file concurrently would cause the second write to overwrite the first.
  - `vault.on('create')` handler triggers `syncAllLinks()` instead of just `syncPriorityTasks()`.
  - Initial sync on layout ready calls `syncAllLinks()`.
  - Add command: "Sync all task links now".

**Why sequential**: Each sync operation reads the daily note, modifies it, and writes it back. If two syncs ran concurrently, the second read could happen before the first write completes, causing lost data. A simple `for...of` loop with `await` eliminates this entirely.

**Section header must exist**: `syncAllLinks()` calls each link's sync method, which calls `DailyNoteService.appendNewTasks()`. If the section header for a link is not found in the daily note, that link returns 0 and is skipped. The user controls which sections exist by including headers in their daily note template.

**Validation**: Create a new daily note with appropriate section headers, verify all enabled connections sync their tasks.

---

## Phase 8 — Collapsible Callout Rendering

**Goal**: When `collapsible: true` on a TaskLink, render its section as an Obsidian callout block.

**Daily note format**:
```markdown
> [!todo]- Homework
> - [ ] Read chapter 5
> - [ ] Complete worksheet
```

**Files**:
- **MODIFY** `src/services/DailyNoteService.ts`:
  - `appendNewTasks` with collapsible: format lines as `> - [ ] ...`, header as `> [!todo]- HeaderText`.
  - `readExistingTasks` with collapsible: parse `> ` prefixed lines, strip prefix before checkbox matching.
  - `findSectionInsertPoint` with collapsible: match `> [!todo]- HeaderText` and `> [!todo]+ HeaderText` (both collapsed/expanded).
- **MODIFY** `src/utils/TaskParser.ts` — Add `stripCalloutPrefix(line): string` that removes leading `> `.
- **MODIFY** `src/services/ReverseSyncService.ts` and `src/services/SourceToDailySyncService.ts` — Strip `> ` prefix before matching tasks in collapsible sections.

**Edge case**: User manually changes `-` to `+` (expand/collapse). Both variants must be recognized.

**Validation**: Enable collapsible on a connection, verify it renders as a callout. Verify bidirectional sync works through the callout prefix.

---

## Phase 9 — Polish and Edge Cases

1. **Deduplication across links**: Each section deduplicates independently. If the same task appears in two sections (e.g., a priority task in a mirrored note), that is by design — the user configured both.
2. **Section headers are user-controlled**: The plugin does not create, reorder, or manage section headers. Each link has a `sectionHeader` string in its config (must be `##` level). If that header exists in the daily note, the link syncs to it. If it doesn't exist, the link is silently skipped. Users place headers in their daily note template in whatever order they prefer.
3. **Section header uniqueness**: Enforced as a hard validation error in the settings UI — no two links may share the same `sectionHeader`. This prevents ambiguous section ownership which would break bidirectional sync.
4. **Task formatting by type**:
   - Priority-scan: `- [ ] {displayText} {priorityEmoji} {wikilink}` — wikilink to source file, since tasks come from many files across the vault.
   - Note-mirror: `- [ ] {displayText}` — raw task text (checkbox prefix stripped), no wikilink. The source note reference lives in the link config. Users can optionally put a wikilink in the section header itself (e.g., `## [[Homework]]`) but this is entirely their choice.
5. **`includeCompleted` behavior**: When `includeCompleted` is `false` on a note-mirror link, completed tasks in the source note are not *added* to the daily note. However, if a task is already on the daily note and subsequently gets checked (either directly or via reverse sync), it is **not removed**. The plugin never removes tasks from the daily note — see Architectural Decisions: "Append-only daily note."
6. **Debug logging**: All new code paths respect `settings.enableDebugLogging` with `[TaskSync]` prefix.
7. **Plugin naming**: Consider updating display name from "Task Sync" to "Task Links" in manifest.json.

---

## Dependency Graph

```
Phase 1 (Data Model + Migration)
  │
  ├── Phase 2 (DailyNoteService Multi-Section)
  │     │
  │     └──┐
  │        │
  ├── Phase 3 (NoteMirrorScanner) ─── can run in parallel with Phase 2
  │        │
  │        ▼
  │   Phase 4 (FileWatcher Refactor) ─── needs Phase 2 + 3
  │     │
  │     ▼
  │   Phase 5 (Bidirectional Sync) ─── needs Phase 4; REQUIRED for note-mirror reverse sync
  │     │
  │     ▼
  │   Phase 6 (Settings UI) ─── can start alongside Phase 4/5, full test needs them
  │     │
  │     ▼
  │   Phase 7 (Daily Note Creation + Full Sync)
  │     │
  │     ▼
  │   Phase 8 (Collapsible Callouts) ─── most isolated, can be deferred
  │     │
  │     ▼
  │   Phase 9 (Polish)
```

Phases 1 → 2 → 4 → 5 form the critical path. Phase 3 can be done in parallel with Phase 2. Phase 8 is the most isolated feature.

---

## Architectural Decisions

### Shared services, not per-link instances
DailyNoteService, ReverseSyncService, and SourceToDailySyncService remain as shared singletons that accept a `TaskLink` parameter per operation. Creating one instance per link would cause race conditions when multiple instances write to the same daily note file.

### Sequential sync execution
`syncAllLinks()` processes links one at a time with `await`. Each sync reads, modifies, and writes the daily note. Concurrent execution would cause write conflicts where the second write overwrites the first. Sequential execution is simple and correct.

### Two matching strategies by link type
Priority-scan and note-mirror tasks use different matching approaches because they have different constraints:
- **Priority-scan**: Tasks come from anywhere in the vault. Source file identified by wikilink in the task line. Matching uses aggressively cleaned text (`cleanTaskText`) as the primary signal since line numbers are unreliable across many files.
- **Note-mirror**: Tasks come from one known file. Source file identified by link config. Matching uses `displayText` (lightly cleaned — checkbox prefix stripped only) as the primary signal. Line number is a tie-breaker only, used when multiple tasks in the source have identical text. Line numbers must not be the primary signal because any insertion or deletion above a task shifts all line numbers below it.

### Note-mirror tasks have no wikilinks
Mirrored tasks are displayed as-is (minus checkbox prefix) without appending a wikilink. This is intentional:
- All tasks in a mirror section come from the same source note, so per-task wikilinks are redundant.
- The source note reference is stored in the link config and can optionally appear in the section header.
- This keeps mirrored task lines clean and readable.
- Reverse sync uses section boundaries + link config to find the source, not wikilinks.

### Section headers are user-controlled
The plugin does not auto-create section headers on the daily note. If a link's `sectionHeader` doesn't exist in the daily note, that link simply doesn't sync. This gives users full control over their daily note layout and avoids the complexity of an automatic section ordering algorithm.

### Source note lifecycle handling
The plugin registers vault event handlers for file rename and delete:
- **Rename/move**: Any note-mirror link pointing to the old path is updated to the new path. Settings are saved automatically.
- **Delete**: Any note-mirror link pointing to the deleted file is disabled (`enabled: false`). A `Notice` informs the user. The link config is preserved so the user can re-enable it if they recreate the file.

### Section headers restricted to `##` level
All `sectionHeader` values must be `##` level headers. This is enforced in the settings UI. The constraint simplifies section boundary detection: a section starts at its `##` header and ends at the next `#` or `##` header (level 1 or 2), or EOF. Nested `###` and below are content within the section. Without this constraint, boundary detection would need complex "greedy vs strict" logic to handle ambiguous nesting (e.g., a `### Homework` inside a `## High Priority` section).

### Section header uniqueness enforced
No two TaskLinks may share the same `sectionHeader`. This is a hard validation error in the settings UI, not a warning. Uniqueness is required because section boundaries are used to determine which link owns each task for bidirectional sync. Duplicate headers would make ownership ambiguous.

### Append-only daily note
The plugin never removes tasks from the daily note. It only *adds* new tasks and *updates* checkbox state on existing tasks. This is an explicit architectural invariant with several implications:
- `includeCompleted: false` means "don't add completed tasks to the daily note," not "remove tasks that become completed." If a task is already on the daily note and gets checked, it stays.
- Tasks that are deleted from a source note are not removed from the daily note — they just won't be re-added if the section is cleared manually.
- This prevents the plugin from "eating" tasks and ensures the daily note is a reliable record of what was synced.

### Shared processing guard prevents sync ping-pong
A centralized `pluginModifiedFiles: Set<string>` on the plugin instance tracks which file paths the plugin is currently writing to. This replaces the per-service `isProcessing` booleans. Before any service writes via `vault.modify()`, it adds the path to the set. After the write, it removes the path after ~100ms (to account for async event firing). When any file watcher fires for a path in this set, processing is skipped. This prevents loops: ReverseSyncService checks a task in source → SourceToDailySyncService sees the source file change → but skips it because the path is in the guard set.

### Use `vault.cachedRead()` for note-mirror scanning
`NoteMirrorScannerService` uses `vault.cachedRead()` instead of `vault.read()`. The cached variant returns Obsidian's in-memory file content without hitting disk, which is faster. Since note mirrors only read a single file per link (not the entire vault), the performance difference is modest, but there's no reason to pay the disk I/O cost. Additionally, `metadataCache.getFileCache(file).listItems` can be used as a fast bail-out — if the source note has no list items, skip the read entirely.

### Existing multi-signal matching handles line drift
`TaskParser.matchTasks()` uses cleanText as the strong signal and line number as a weak signal. When sections shift (tasks added/removed above), cleanText matching still works. No changes needed to the matching algorithm for priority-scan tasks.

### Callout prefix stripped at call site
Rather than modifying TaskParser's core methods to handle `> ` prefixes (which could have side effects), we strip the prefix at the call site before passing lines to TaskParser. This keeps TaskParser clean and callout-unaware.

### Settings migration uses a version number
A `settingsVersion` field in settings enables robust migration detection rather than heuristic sniffing of the settings shape.

### restartServices triggers a full sync
When settings change (e.g., a new note-mirror link is added), `restartServices()` stops all services, restarts them, and then calls `syncAllLinks()`. This ensures new links sync immediately rather than waiting for the next file change event.
