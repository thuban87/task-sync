# Task Sync — Obsidian Plugin

## What This Plugin Does

Task Sync scans the vault for high-priority tasks (marked with ⏫ or 🔺 emojis) and syncs them into a designated section on today's daily note. It supports bidirectional sync: checking a task on the daily note checks it in the source file, and vice versa.

The plugin is being refactored into a multi-connection "Task Links" system. See `docs/Task Links Refactor Plan.md` for the full plan. Until that refactoring begins, everything below describes the current (pre-refactor) state.

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
  settings.ts                            # PluginSettings interface, defaults, settings UI
  models/
    PriorityTask.ts                      # Data interfaces: PriorityTask, SyncedTask, CheckboxState
  utils/
    TaskParser.ts                        # Static utility class: text cleaning, priority extraction,
                                         #   multi-signal task matching, checkbox state parsing
  services/
    TaskScannerService.ts                # Vault-wide scan for priority tasks (uses metadataCache)
    DailyNoteService.ts                  # Read/write tasks on daily note, section management
    FileWatcherService.ts                # Debounced file change detection, loop prevention
    ReverseSyncService.ts                # Daily note → source file checkbox sync
    SourceToDailySyncService.ts          # Source file → daily note checkbox sync
```

### Data Flow

```
VAULT FILES
  │
  ├─ [FileWatcherService] ── debounces modify events, ignores daily note
  │    │
  │    ▼
  ├─ [TaskScannerService] ── full vault scan or incremental single-file scan
  │    │
  │    ▼  (PriorityTask[])
  ├─ [main.syncPriorityTasks()] ── filters by priority settings, applies task limit
  │    │
  │    ▼
  └─ [DailyNoteService.appendNewTasks()] ── deduplicates by cleanText, appends new tasks
       │
       ▼
     DAILY NOTE

DAILY NOTE (user edits)
  │
  ├─ [ReverseSyncService] ── detects checkbox changes via multi-signal matching
  │    │
  │    ▼
  └─ SOURCE FILE (checkbox updated)

SOURCE FILE (user edits)
  │
  ├─ [SourceToDailySyncService] ── detects checkbox changes in files with synced tasks
  │    │
  │    ▼
  └─ DAILY NOTE (checkbox updated)
```

### Key Interfaces

**`PriorityTask`** (`src/models/PriorityTask.ts`) — A task found during vault scanning:
- `originalLine` — raw text from source file
- `cleanText` — normalized text for dedup/matching (stripped of checkbox, emojis, wikilinks, metadata)
- `filePath` — source file path (relative to vault root)
- `lineNumber` — 0-indexed line in source file
- `priority` — `'highest'` | `'high'`

**`SyncedTask`** (`src/models/PriorityTask.ts`) — A task already on the daily note:
- `cleanText`, `line`, `completed`, `lineNumber`

**`CheckboxState`** (`src/models/PriorityTask.ts`) — Tracks checkbox state for reverse sync:
- `lineNumber`, `checked`, `cleanText`, `sourcePath`

**`TaskState`** (`src/utils/TaskParser.ts`) — Full task state for multi-signal matching:
- `lineNumber`, `cleanText`, `priority`, `checked`, `sourcePath`, `originalLine`

**`PluginSettings`** (`src/settings.ts`) — Flat settings object with enabled, sectionHeader, taskLimit, debounceMs, priority filters, reverse sync toggle, exclusion lists, debug logging.

### Service Lifecycle

All services are instantiated in `main.ts onload()`. Services are started/stopped based on `settings.enabled`:

1. `startServices()` — starts FileWatcher, registers daily note creation listener, initializes reverse sync
2. `stopServices()` — stops FileWatcher, stops reverse sync watchers, cleans up event listeners

The daily note creation listener (`vault.on('create')`) triggers an initial sync + reverse sync setup when today's daily note is first created.

---

## Important Patterns

### Multi-Signal Task Matching

`TaskParser.matchTasks()` matches tasks between two states using a scoring system:
- **cleanText match**: +3 points (strong signal)
- **priority match**: +1 point (supporting signal)
- **lineNumber match**: +1 point (weak signal)
- Minimum 2 points required for a match

This handles tasks that move lines, change priority, or get slightly edited. It's the core algorithm for bidirectional sync change detection.

### Deduplication

`DailyNoteService.appendNewTasks()` reads existing tasks from the target section and builds a `Set<cleanText>`. New tasks whose `cleanText` already exists are filtered out. Both completed and uncompleted existing tasks are included in the set to prevent race condition duplicates.

### Loop Prevention

Three mechanisms prevent infinite sync loops:
1. **FileWatcherService** ignores the daily note entirely (path check in `shouldTriggerSync`)
2. **ReverseSyncService** has an `isProcessing` flag to prevent re-entry during its own writes
3. **SourceToDailySyncService** has an `isProcessing` flag for the same reason

These per-service flags are a known weakness — they don't protect against cross-service loops (ReverseSyncService writing to a source file triggering SourceToDailySyncService). The refactor plan addresses this with a shared processing guard.

### Incremental Scanning

FileWatcherService tracks which file triggered the debounce. If a single file changed, it passes that file to `syncPriorityTasks(file)` for an incremental scan of just that file. If multiple different files changed during the debounce window, `pendingFile` is cleared and a full vault scan runs.

### Section Detection

`DailyNoteService.findSectionInsertPoint()` finds the target section by exact string match on `settings.sectionHeader`. Tasks are inserted immediately after the header. `readExistingTasks()` reads from the header until the next `#`-prefixed line (any heading level) or EOF.

---

## Performance Considerations

- **metadataCache for filtering**: `TaskScannerService.hasListItems()` uses `metadataCache.getFileCache(file).listItems` to skip files without list items. This avoids reading files that can't possibly contain tasks. Only used for full vault scans — skipped for incremental scans since cache may be stale.
- **vault.read() vs vault.cachedRead()**: The current codebase uses `vault.read()` everywhere. `vault.cachedRead()` returns Obsidian's in-memory cached content without disk I/O and should be preferred when fresh-from-disk accuracy isn't critical.
- **Debounce window**: Configurable 500-10000ms (default 3500ms). Prevents rapid-fire syncs when the user is actively editing. All vault modify events during the window are collapsed into a single sync.
- **Task limit**: `settings.taskLimit` caps the number of tasks appended per full vault scan (0 = unlimited). Not applied during incremental scans to avoid cutting off newly added tasks.

---

## Security & Safety Notes

- The plugin only reads and writes files within the Obsidian vault via the `vault` API. It does not make network requests or access the filesystem directly.
- `deploy.mjs` copies the built plugin to vault paths. These paths are local and configured in the deploy script.
- No user credentials or sensitive data are stored. Settings are persisted via Obsidian's `plugin.saveData()` (writes to `.obsidian/plugins/task-sync/data.json`).
- The autocomplete suggestions dropdown in settings (`showSuggestions`) injects DOM elements with inline styles. The content comes from vault file/folder paths (not user-generated text that could contain scripts), but this pattern should not be extended to untrusted input.

---

## Tech Debt & Known Issues

1. **Per-service `isProcessing` flags**: `ReverseSyncService` and `SourceToDailySyncService` each have their own `isProcessing` boolean. These prevent self-triggered loops but don't prevent cross-service ping-pong. A checkbox toggle in the daily note can trigger: ReverseSyncService → writes to source → SourceToDailySyncService fires → writes back to daily note. In practice the `isProcessing` flag on SourceToDailySyncService catches this because the events fire fast enough, but it's timing-dependent and fragile. The refactor plan introduces a shared `pluginModifiedFiles` set to fix this properly.

2. **`SourceToDailySyncService` hard-codes priority check**: In `handleSourceFileModified()` (line 114), the service requires `TaskParser.extractPriority(line)` to be truthy when scanning source files. This means it only recognizes tasks with priority emojis. This is correct for the current single-purpose plugin but will break for note-mirror tasks which have no priority emojis. Must be addressed during refactoring.

3. **`ReverseSyncService` parses entire daily note**: `parseAllTaskStates()` parses every checkbox in the daily note, not just those in the plugin's target section. If the user has other checkbox content in their daily note, the service wastes cycles processing it and could theoretically produce false matches.

4. **Settings UI inline styles**: `showSuggestions()` in settings.ts uses inline CSS (`style.cssText`). This works but is fragile — it doesn't respond to theme changes or window resizing after render. No dedicated CSS file exists for the plugin.

5. **No settings validation on load**: `loadSettings()` only validates `debounceMs` bounds. Other settings (e.g., empty `sectionHeader`, `taskLimit` set to a negative number via manual JSON edit) are not validated.

6. **`startServices`/`stopServices` are public**: These are called from the settings UI toggle (line 87-89 in settings.ts). This is intentional but means external code could call them. The refactor should ensure `restartServices()` is the only public-facing lifecycle method beyond `onload`/`onunload`.

7. **No test framework**: There are no automated tests. TaskParser's static methods and the service logic are testable in isolation. Consider adding vitest or jest if the codebase grows during refactoring.

8. **`vault.read()` used everywhere**: Should be `vault.cachedRead()` in most places for performance. `vault.read()` forces a disk read; `vault.cachedRead()` returns the in-memory cache. The only time `vault.read()` is needed is immediately after another process (not Obsidian) writes to a file.

---

## Coding Conventions

- **All logging** uses `[TaskSync]` prefix and is gated behind `settings.enableDebugLogging`. Use `console.debug` for routine tracing, `console.log` for significant events, `console.warn` for recoverable errors.
- **Services** are classes instantiated once in `main.ts`. They receive `app`, `settings`, and other services via constructor injection. They do not import the plugin class directly.
- **TaskParser** is a static utility class — no instance state, all methods are `static`. It should remain stateless and side-effect-free.
- **Constants** are in `src/constants.ts`. Regex patterns are module-level `const` exports.
- **Interfaces** live in `src/models/`. The `TaskState` interface is an exception — it lives in `TaskParser.ts` because it's tightly coupled to the parser.
- **Error handling**: Services catch errors internally and return safe defaults (empty arrays, 0 counts, false). They never throw to callers. Errors are logged to console when debug logging is enabled.
- **Event cleanup**: All Obsidian `EventRef` objects are stored and cleaned up in `stopWatching()`/`stop()` methods via `vault.offref()`.

---

## Obsidian API Notes

- **`vault.on('modify', callback)`** — fires after any file is modified. Returns an `EventRef` that must be cleaned up with `vault.offref()`.
- **`vault.on('create', callback)`** — fires when a new file is created. Used to detect daily note creation.
- **`vault.read(file)`** — reads file from disk. Async.
- **`vault.cachedRead(file)`** — reads from Obsidian's in-memory cache. Async but faster. Preferred unless you need guaranteed-fresh content.
- **`vault.modify(file, content)`** — overwrites file content. Triggers `modify` events (which is why loop prevention matters).
- **`metadataCache.getFileCache(file)`** — returns cached parse results including `listItems`, `headings`, `links`, etc. Fast. May be briefly stale after a file edit.
- **`metadataCache.getFirstLinkpathDest(linkPath, sourcePath)`** — resolves a wikilink target to a `TFile`. Used by `TaskParser.extractSourcePath()`.
- **`fileManager.generateMarkdownLink(file, sourcePath)`** — generates a wikilink or markdown link respecting vault settings. Used by `DailyNoteService.formatTask()`.
- **`obsidian-daily-notes-interface`** — third-party library providing `getDailyNote()` and `getAllDailyNotes()`. Required because Obsidian's core daily notes plugin doesn't expose a direct API.
