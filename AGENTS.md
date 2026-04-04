# Task Sync — Obsidian Plugin

## What This Plugin Does

Task Sync is a multi-connection task syncing plugin for Obsidian. It syncs tasks from various sources into designated sections on today's daily note, with full bidirectional sync — checking a task on the daily note checks it in the source file, and vice versa.

The plugin supports two connection types ("Task Links"):
- **Priority Scan**: Scans the entire vault for high-priority tasks (marked with ⏫ or 🔺 emojis) and syncs them to a section on the daily note.
- **Note Mirror**: Mirrors tasks from a specific source note into a section on the daily note. Supports section filtering, tag filtering, emoji exclusion, and subtask indentation.

Each connection is configured independently with its own section header, task limit, and sync settings. See `docs/Task Links Refactor Plan.md` for the original design document.

---

## Build & Run

```bash
npm run build          # Type-check (tsc --noEmit) + bundle with esbuild
npm run dev            # Dev build (watches for changes)
npm run deploy:test    # Build + deploy to test vault
npm run deploy:staging # Build + deploy to staging vault
```

- Entry point: `main.ts` → bundled to `main.js` by esbuild
- TypeScript strict mode is enabled (`strict: true` in tsconfig)
- Target: ES6, module: ESNext
- Single runtime dependency: `obsidian-daily-notes-interface` (for daily note access)
- No test framework is configured

---

## Codebase Architecture

```
main.ts                                  # Plugin entry point, lifecycle, orchestration
src/
  constants.ts                           # Regex patterns and emoji marker constants
  settings.ts                            # PluginSettings interface, defaults, migration, settings UI
  models/
    TaskLink.ts                          # TaskLink discriminated union (PriorityScanLink | NoteMirrorLink)
    SyncableTask.ts                      # Data interfaces: SyncableTask, SyncedTask, CheckboxState
  utils/
    TaskParser.ts                        # Static utility class: text cleaning, priority extraction,
                                         #   multi-signal task matching, checkbox state parsing
  services/
    TaskScannerService.ts                # Vault-wide scan for priority tasks (uses metadataCache)
    NoteMirrorScannerService.ts          # Single source note scan for note-mirror connections
    DailyNoteService.ts                  # Read/write tasks on daily note, multi-section management
    FileWatcherService.ts                # Debounced file change detection, link routing
    ReverseSyncService.ts                # Daily note → source file checkbox sync (multi-link)
    SourceToDailySyncService.ts          # Source file → daily note checkbox sync (multi-link)
```

### Data Flow

```
VAULT FILES (priority-scan)                SOURCE NOTE (note-mirror)
  │                                          │
  ├─ [FileWatcherService]                    ├─ [FileWatcherService]
  │    routes to affected linkIds            │    routes to affected linkIds
  │    │                                     │    │
  │    ▼                                     │    ▼
  ├─ [TaskScannerService]                    ├─ [NoteMirrorScannerService]
  │    full vault or incremental scan        │    scans source note by sections
  │    │                                     │    │
  │    ▼  (SyncableTask[])                   │    ▼  (SyncableTask[])
  ├─ [main.syncAllLinks()]                   ├─ [main.syncAllLinks()]
  │    filters by priority, applies limit    │    
  │    │                                     │
  │    ▼                                     │
  └─ [DailyNoteService.appendNewTasks()]     └─ [DailyNoteService.appendNewTasks()]
       deduplicates by displayText                deduplicates by displayText
       │                                          preserves subtask indentation
       ▼                                          │
     DAILY NOTE                                   ▼
                                               DAILY NOTE

DAILY NOTE (user edits)
  │
  ├─ [ReverseSyncService] ── detects checkbox changes via multi-signal matching
  │    uses findSectionBoundaries to determine link ownership
  │    │
  │    ▼
  └─ SOURCE FILE (checkbox updated)

SOURCE FILE (user edits)
  │
  ├─ [SourceToDailySyncService] ── detects checkbox changes via cached task map
  │    link-type-aware matching (cleanTaskText vs trimCheckbox)
  │    │
  │    ▼
  └─ DAILY NOTE (checkbox updated)
```

### Key Interfaces

**`TaskLink`** (`src/models/TaskLink.ts`) — Discriminated union for connection configuration:
- `TaskLinkBase`: shared fields — `id`, `type`, `enabled`, `sectionHeader`, `taskLimit`, `collapsible`, `calloutType`, `enableBidirectionalSync`
- `PriorityScanLink`: adds `includeHighest`, `includeHigh`, `excludedFolders`, `excludedFiles`, `excludedFileNames`
- `NoteMirrorLink`: adds `sourceNotePath`, `sourceSections`, `excludeEmoji`, `includeCompleted`, `filterTags`

**`SyncableTask`** (`src/models/SyncableTask.ts`) — A task found during scanning:
- `originalLine` — raw text from source file
- `displayText` — normalized text for dedup/matching (cleaning level depends on link type)
- `filePath` — source file path (relative to vault root)
- `lineNumber` — 0-indexed line in source file
- `priority` — `'highest'` | `'high'` (optional, only for priority-scan)
- `linkId` — which TaskLink connection produced this task
- `indent` — leading whitespace from original line (for preserving subtask nesting)

**`SyncedTask`** (`src/models/SyncableTask.ts`) — A task already on the daily note:
- `displayText`, `line`, `completed`, `lineNumber`

**`TaskState`** (`src/utils/TaskParser.ts`) — Full task state for multi-signal matching:
- `lineNumber`, `displayText`, `priority`, `checked`, `sourcePath`, `originalLine`

**`PluginSettings`** (`src/settings.ts`) — Top-level settings:
- `settingsVersion` (currently 1), `enabled`, `debounceMs`, `enableDebugLogging`, `taskLinks: TaskLink[]`

### Service Lifecycle

All services are instantiated in `main.ts onload()`. Services are started/stopped based on `settings.enabled`:

1. `startServices()` — starts FileWatcher, registers daily note creation listener, initializes reverse sync and source-to-daily sync for all enabled links
2. `stopServices()` — stops FileWatcher, stops reverse sync watchers, cleans up event listeners
3. `restartServices()` — calls stop + start + syncAllLinks (used by settings UI)

The daily note creation listener (`vault.on('create')`) triggers an initial sync + reverse sync setup when today's daily note is first created.

Additional lifecycle handlers:
- `vault.on('rename')` — updates `sourceNotePath` on note-mirror links when source files are renamed
- `vault.on('delete')` — disables affected note-mirror links with a Notice when source files are deleted

### Settings Migration

`migrateSettings(data)` in `settings.ts` handles version upgrades:
- **Version 0→1**: Converts old flat format (single `sectionHeader`, `taskLimit`, etc.) into `taskLinks[]` array with one `PriorityScanLink`. Auto-saves after migration.

---

## Important Patterns

### Multi-Signal Task Matching

`TaskParser.matchTasks()` matches tasks between two states using a scoring system:
- **displayText match**: +3 points (strong signal)
- **priority match**: +1 point (supporting signal)
- **lineNumber match**: +1 point (weak signal)
- Minimum 2 points required for a match

This handles tasks that move lines, change priority, or get slightly edited. It's the core algorithm for bidirectional sync change detection.

### Text Cleaning (Two Levels)

- **`cleanTaskText(line)`** — Aggressive cleaning for priority-scan tasks. Strips: callout prefix, checkbox, priority emojis, Tasks plugin metadata (✅📅⏳🛫🔁➕ with dates), wikilinks, markdown links. Used for dedup and matching.
- **`trimCheckbox(line)`** — Light cleaning for note-mirror tasks. Strips: callout prefix, checkbox prefix, Tasks plugin completion metadata (✅ with dates). Preserves bold, tags, and other content.

### Deduplication

`DailyNoteService.appendNewTasks()` reads existing tasks from the target section and builds a `Set<displayText>`. New tasks whose `displayText` already exists are filtered out. Both completed and uncompleted existing tasks are included in the set to prevent race condition duplicates.

### Loop Prevention

A shared `pluginModifiedFiles: Set<string>` on the plugin instance prevents sync loops:
- Before writing to a file, the path is added to the set
- After 100ms, the path is removed
- `FileWatcherService`, `ReverseSyncService`, and `SourceToDailySyncService` all check this set before processing a file modification event

### Incremental Scanning

FileWatcherService tracks which file triggered the debounce and which link IDs are affected. If a single file changed, it passes that file to the sync handler. If multiple files changed during the debounce window, affected link IDs are merged. The handler routes to `syncPriorityScanLink()` or `syncNoteMirrorLink()` based on link type.

### Section Detection

`DailyNoteService.findHeaderLine()` finds a section header by:
1. For collapsible sections: first tries callout syntax `> [!type]- HeaderText` / `> [!type]+ HeaderText`, then falls back to plain heading match
2. For plain sections: exact heading match (e.g., `## My Section`)

Section boundaries are determined by heading hierarchy — a section ends at the next heading of same or higher level, or EOF. For callout sections, content ends when lines no longer start with `> `.

### Subtask Indentation

Note-mirror tasks preserve their original indentation. `NoteMirrorScannerService` captures the leading whitespace from each source line into `SyncableTask.indent`. `DailyNoteService.formatTask()` prepends this indent when rendering on the daily note.

### Collapsible Callout Auto-Creation

When a collapsible link targets a plain heading (e.g., `## ENG 102 Homework`), `appendNewTasks` automatically creates the callout structure below the heading on first sync:
```
## ENG 102 Homework
> [!todo]- ENG 102 Homework
> - [ ] Task 1
> - [ ] Task 2
```

---

## Performance Considerations

- **metadataCache for filtering**: `TaskScannerService.hasListItems()` and `NoteMirrorScannerService` use `metadataCache.getFileCache(file).listItems` to skip files without list items. Only used for full vault scans — skipped for incremental scans since cache may be stale.
- **vault.cachedRead()**: Used for reading file content in most places. Returns Obsidian's in-memory cache without disk I/O. `vault.read()` is only used in reverse sync services where guaranteed-fresh content is needed after external modifications.
- **Debounce window**: Configurable 500-10000ms (default 3500ms). Prevents rapid-fire syncs when the user is actively editing. All vault modify events during the window are collapsed into a single sync.
- **Task limit**: Per-link `taskLimit` caps tasks appended per sync (0 = unlimited). Only applied during full vault scans for priority-scan links.
- **Sequential sync execution**: Links are synced sequentially in `syncAllLinks()` to prevent concurrent writes to the daily note.

---

## Security & Safety Notes

- The plugin only reads and writes files within the Obsidian vault via the `vault` API. It does not make network requests or access the filesystem directly.
- `deploy.mjs` copies the built plugin to vault paths. These paths are local and configured in the deploy script.
- No user credentials or sensitive data are stored. Settings are persisted via Obsidian's `plugin.saveData()` (writes to `.obsidian/plugins/task-sync/data.json`).
- The autocomplete suggestions dropdown in settings (`showSuggestions`) injects DOM elements with inline styles. The content comes from vault file/folder paths (not user-generated text that could contain scripts), but this pattern should not be extended to untrusted input.
- `console.warn` is monkey-patched in `onload()` to suppress a specific obsidian-tasks-plugin warning about callout checkboxes. The original is restored in `onunload()`.

---

## Tech Debt & Known Issues

1. **`ReverseSyncService` parses entire daily note**: `parseAllTaskStates()` parses every checkbox in the daily note, not just those in the plugin's target sections. Section ownership is determined after parsing via `findSectionBoundaries()`. If the user has many checkboxes outside managed sections, the service wastes cycles processing them.

2. **Settings UI inline styles**: `showSuggestions()` in settings.ts uses inline CSS (`style.cssText`). This works but is fragile — it doesn't respond to theme changes or window resizing after render. No dedicated CSS file exists for the plugin.

3. **No settings validation on load**: `loadSettings()` only validates `debounceMs` bounds. Other settings (e.g., empty `sectionHeader`, `taskLimit` set to a negative number via manual JSON edit) are not validated.

4. **No test framework**: There are no automated tests. TaskParser's static methods and the service logic are testable in isolation. Consider adding vitest or jest if the codebase grows.

5. **Tasks plugin callout interaction**: The obsidian-tasks-plugin shows a notification toast when clicking checkboxes inside callouts in Live Preview. The `console.warn` is suppressed but the Notice toast is not. Users should use Reading View or the "Toggle Task Done" command for callout tasks, or avoid the collapsible option.

6. **Collapsible + heading coexistence**: When collapsible is enabled, both a plain heading and a callout line exist in the daily note (heading for visual structure, callout for rendering). This is intentional but creates a slightly unusual document structure.

---

## Coding Conventions

- **All logging** uses `[TaskSync]` prefix and is gated behind `settings.enableDebugLogging`. Use `console.debug` for routine tracing, `console.log` for significant events, `console.warn` for recoverable errors.
- **Services** are classes instantiated once in `main.ts`. They receive `app`, `settings`, and other services via constructor injection. They do not import the plugin class directly.
- **TaskParser** is a static utility class — no instance state, all methods are `static`. It should remain stateless and side-effect-free.
- **Constants** are in `src/constants.ts`. Regex patterns are module-level `const` exports. Checkbox regexes support optional `> ` callout prefix.
- **Interfaces** live in `src/models/`. The `TaskState` interface is an exception — it lives in `TaskParser.ts` because it's tightly coupled to the parser.
- **Error handling**: Services catch errors internally and return safe defaults (empty arrays, 0 counts, false). They never throw to callers. Errors are logged to console when debug logging is enabled.
- **Event cleanup**: All Obsidian `EventRef` objects are stored and cleaned up in `stopWatching()`/`stop()` methods via `vault.offref()`.
- **Shared processing guard**: All file writes use the `pluginModifiedFiles` set pattern: add path before `vault.modify()`, remove after 100ms timeout.

---

## Obsidian API Notes

- **`vault.on('modify', callback)`** — fires after any file is modified. Returns an `EventRef` that must be cleaned up with `vault.offref()`.
- **`vault.on('create', callback)`** — fires when a new file is created. Used to detect daily note creation.
- **`vault.on('rename', callback)`** — fires when a file is renamed/moved. Used to update `sourceNotePath` on note-mirror links.
- **`vault.on('delete', callback)`** — fires when a file is deleted. Used to disable affected note-mirror links.
- **`vault.read(file)`** — reads file from disk. Async.
- **`vault.cachedRead(file)`** — reads from Obsidian's in-memory cache. Async but faster. Preferred unless you need guaranteed-fresh content.
- **`vault.modify(file, content)`** — overwrites file content. Triggers `modify` events (which is why loop prevention matters).
- **`metadataCache.getFileCache(file)`** — returns cached parse results including `listItems`, `headings`, `links`, etc. Fast. May be briefly stale after a file edit.
- **`metadataCache.getFirstLinkpathDest(linkPath, sourcePath)`** — resolves a wikilink target to a `TFile`. Used by `TaskParser.extractSourcePath()`.
- **`fileManager.generateMarkdownLink(file, sourcePath)`** — generates a wikilink or markdown link respecting vault settings. Used by `DailyNoteService.formatTask()`.
- **`obsidian-daily-notes-interface`** — third-party library providing `getDailyNote()` and `getAllDailyNotes()`. Required because Obsidian's core daily notes plugin doesn't expose a direct API.
