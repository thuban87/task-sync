# Task Sync Plugin - Session Log

Development log for the Task Sync Obsidian plugin.

> **Started:** 2026-02-03  
> **Status:** Production Release

---

## Session Format

Each session entry includes:
- **Date & Focus:** What was worked on
- **Completed:** Checklist of completed items
- **Files Changed:** Key files modified/created
- **Testing Notes:** What was tested and results
- **Next Steps:** What to continue with

---

## 2026-02-03 - Initial Development & Production Release

**Focus:** Complete plugin development from scaffolding to production deployment

### Completed:

#### Phase 1: Project Scaffolding
- ✅ Created `manifest.json`, `package.json`, `tsconfig.json`
- ✅ Created `esbuild.config.mjs` (build config)
- ✅ Created `deploy.mjs` (multi-environment deployment script: test/staging/production)
- ✅ Created `.agent/workflows/deploy.md` workflow
- ✅ Installed dependencies (`npm install`)

#### Phase 2: Core Constants & Models
- ✅ Created `src/constants.ts` (priority markers, regex patterns)
- ✅ Created `src/models/PriorityTask.ts` (task interfaces)

#### Phase 3: Services
- ✅ `TaskScannerService.ts` - Vault scanning with metadataCache optimization
- ✅ `DailyNoteService.ts` - Daily note detection (Periodic Notes/Daily Notes compatible)
- ✅ `FileWatcherService.ts` - File modification watching with debounce
- ✅ `ReverseSyncService.ts` - Daily Note → Source file sync
- ✅ `SourceToDailySyncService.ts` - Source file → Daily Note sync (true two-way)

#### Phase 4: Settings & Main Entry
- ✅ Created `src/settings.ts` with full settings UI
- ✅ Created `main.ts` (plugin entry point)
- ✅ Manual sync command: "Sync priority tasks now"

#### Phase 5: Feature Implementation

**Two-Way Task Sync:**
- ✅ Vault → Daily Note: Priority tasks auto-sync to section header
- ✅ Daily Note → Source: Checkbox changes propagate back to source files
- ✅ Source → Daily Note: Checkbox changes in source update daily note
- ✅ Task deduplication (only uncompleted tasks count)
- ✅ Daily note creation listener (auto-sync on new daily note)

**Exclusion Settings:**
- ✅ Excluded folders (with path autocomplete)
- ✅ Excluded files (with path autocomplete)  
- ✅ Excluded file names (matches across all directories)

**Priority Filters:**
- ✅ Include highest priority (⏫) toggle
- ✅ Include high priority (🔺) toggle
- ✅ Configurable task limit

#### Phase 6: Production Cleanup
- ✅ Removed all verbose debug logging (39 console.log statements)
- ✅ Kept only essential logs (plugin load/unload)
- ✅ Deployed to test, staging, and production vaults

### Files Structure:

```
task-sync/
├── main.ts                              # Plugin entry point
├── manifest.json                        # Plugin metadata
├── package.json                         # Dependencies
├── tsconfig.json                        # TypeScript config
├── esbuild.config.mjs                   # Build config
├── deploy.mjs                           # Multi-env deployment
├── .agent/workflows/deploy.md           # Deployment workflow
├── docs/                                # Documentation
│   └── Session Log.md                   # This file
└── src/
    ├── constants.ts                     # Regex, priority markers
    ├── settings.ts                      # Settings interface & UI
    ├── models/
    │   └── PriorityTask.ts              # Task model
    └── services/
        ├── TaskScannerService.ts        # Vault scanning
        ├── DailyNoteService.ts          # Daily note handling
        ├── FileWatcherService.ts        # File modification watcher
        ├── ReverseSyncService.ts        # Daily → Source sync
        └── SourceToDailySyncService.ts  # Source → Daily sync
```

### Testing Notes:

- ✅ Build passes (`npm run build`)
- ✅ Deployed and tested on test vault
- ✅ Deployed and tested on staging vault  
- ✅ Deployed to production vault
- ✅ Two-way sync working in both directions
- ✅ Exclusion settings working correctly
- ✅ No console spam in production

### Bugs Fixed During Development:

1. **Daily note not found at startup** - Added workspace.onLayoutReady() listener
2. **Reverse sync not starting** - Added daily note creation listener
3. **Modify events not firing** - Fixed event watcher registration
4. **Completed tasks blocking resync** - Changed deduplication to only consider uncompleted tasks
5. **Source → Daily sync missing** - Created SourceToDailySyncService

---

## 2026-02-03 - Polish Phase 1: Foundation Refactoring

**Focus:** Code centralization and improved task matching

### Completed:

- ✅ Created `src/utils/TaskParser.ts` - centralized shared logic
- ✅ Refactored `TaskScannerService.ts` to use TaskParser
- ✅ Refactored `DailyNoteService.ts` to use TaskParser
- ✅ Refactored `ReverseSyncService.ts` to use TaskParser
- ✅ Refactored `SourceToDailySyncService.ts` to use TaskParser
- ✅ Implemented multi-signal task matching (cleanText + priority + lineNumber)
- ✅ Increased default debounce from 2000ms → 3500ms
- ✅ Increased max debounce slider from 5000ms → 10000ms

### Files Changed:

**Created:**
- `src/utils/TaskParser.ts` - Shared cleaning, parsing, matching logic

**Modified:**
- `src/services/TaskScannerService.ts` - Uses TaskParser
- `src/services/DailyNoteService.ts` - Uses TaskParser
- `src/services/ReverseSyncService.ts` - Uses TaskParser + multi-signal matching
- `src/services/SourceToDailySyncService.ts` - Uses TaskParser
- `src/settings.ts` - Debounce defaults updated

### Code Improvements:

- Removed ~200 lines of duplicated `cleanTaskText()` code
- Task matching now uses 3 signals instead of line number only
- Sync is more resilient to line insertions/deletions

### Testing Notes:

- ✅ Build passes
- ✅ Two-way sync still working
- ✅ Debounce prevents sync during active typing

---

## 2026-02-03 - Polish Phase 2: Incremental Scanning

**Focus:** Performance optimization - only scan files that changed

### Completed:

- ✅ Modified `TaskScannerService.scanVault()` to accept optional `file?: TFile`
- ✅ Added `scanFile(file: TFile)` method for single-file scanning
- ✅ Updated `FileWatcherService` to pass changed file to scanner
- ✅ Added exclusion check to `FileWatcherService.shouldTriggerSync()`
- ✅ Fixed stale cache bug - `scanFile()` skips `hasListItems()` check
- ✅ Fixed multi-file debounce - tracks pending file, falls back to full scan
- ✅ Fixed `taskLimit` bug - limit only applies to full vault scans

### Files Changed:

**Modified:**
- `src/services/TaskScannerService.ts` - Added `scanFile()` method, modified `scanVault()` signature
- `src/services/FileWatcherService.ts` - Passes file to callback, checks exclusions, tracks pending files
- `src/services/DailyNoteService.ts` - Added debug logging (temporary)
- `main.ts` - Updated callback, fixed taskLimit to only apply on full scans

### Bugs Fixed:

1. **Stale metadata cache** - `hasListItems()` uses cache which may not be updated after file modification; fixed by skipping cache check for incremental scans
2. **Task limit truncating new tasks** - `taskLimit` was applied before deduplication, cutting off new tasks; fixed by only applying limit to full vault scans

### Testing Notes:

- ✅ Build passes
- ✅ Excluded files don't trigger scans
- ✅ Non-excluded file changes only scan that file
- ✅ New tasks sync automatically to daily note
- ✅ Manual sync still performs full vault scan

---

## 2026-02-03 - Polish Phase 3: Polish & Cleanup

**Focus:** Clean up rough edges, fix memory leaks, add debug toggle

### Completed:

- ✅ Added `enableDebugLogging` setting to `PluginSettings`
- ✅ Added UI toggle for debug logging in settings (under "Developer" section)
- ✅ Gated verbose logs behind debug setting (troubleshooting logs remain visible)
- ✅ Added debounce to section header text input (300ms)
- ✅ Validated `debounceMs` on settings load (clamped to 500-10000)
- ✅ Cleaned up `create` event listener in `stopServices()` (stored ref for proper cleanup)
- ✅ Updated `ReverseSyncService` to accept settings for debug log gating

### Files Changed:

**Modified:**
- `src/settings.ts` - Added `enableDebugLogging` field, debounce for section header, new "Developer" settings section
- `main.ts` - Added debounceMs validation, stored createEventRef for cleanup
- `src/services/DailyNoteService.ts` - Gated verbose logs behind `enableDebugLogging`
- `src/services/ReverseSyncService.ts` - Added settings parameter, gated success log

### Testing Notes:

- ✅ Build passes (`npm run build`)
- ✅ Debug logging toggle visible in settings
- ✅ Section header changes debounced (no rapid saves)

---

## 2026-02-03 - Polish Phase 4: Optional Hardening

**Focus:** TypeScript strictness, error handling, sync status feedback

### Completed:

- ✅ Verified TypeScript strict mode was already enabled in `tsconfig.json`
- ✅ Removed `/g` global flags from unused regex constants (`PRIORITY_REGEX`, `WIKILINK_REGEX`)
- ✅ Added try/catch error handling to all file operations (12 total):
  - `DailyNoteService.ts` - 2 reads, 1 modify
  - `TaskScannerService.ts` - 1 read
  - `ReverseSyncService.ts` - 3 reads, 1 modify
  - `SourceToDailySyncService.ts` - 3 reads, 1 modify
- ✅ Added sync status Notice toast ("Task Sync: Added N task(s)")
- ✅ Gated all debug/warn console logs behind `enableDebugLogging` setting
- ✅ Added `PluginSettings` to `SourceToDailySyncService` constructor

### Bug Fixed:

**Task duplication on checkbox toggle** - When checking a task in the daily note, duplicates would appear due to a race condition:
1. Task checked → removed from deduplication set (only uncompleted tasks were tracked)
2. Reverse sync updated source file
3. File watcher triggered sync before debounce
4. Since checked task wasn't in dedup set, source task was re-added

**Fix:** Changed deduplication to include ALL tasks (completed + uncompleted), not just uncompleted.

### Files Changed:

**Modified:**
- `src/constants.ts` - Removed `/g` flags from `PRIORITY_REGEX` and `WIKILINK_REGEX`
- `src/services/DailyNoteService.ts` - Try/catch, debug log gating, fixed deduplication
- `src/services/TaskScannerService.ts` - Try/catch, debug log gating
- `src/services/ReverseSyncService.ts` - Try/catch, debug log gating
- `src/services/SourceToDailySyncService.ts` - Try/catch, debug log gating, added settings param
- `main.ts` - Added `Notice` import, sync status toast, debug log gating

### Testing Notes:

- ✅ Build passes (`npm run build`)
- ✅ TypeScript strict mode in effect (was already enabled)
- ✅ Error handling gracefully catches file operation failures
- ✅ Task checkbox toggle in daily note works without duplication
- ✅ Reverse sync updates source file correctly
- ✅ No console spam when debug logging disabled

---

## All Phases Complete! ✅

The Task Sync plugin polish work is complete. All 4 phases have been implemented:

| Phase | Focus | Status |
|-------|-------|--------|
| 1 | Foundation Refactoring | ✅ Complete |
| 2 | Incremental Scanning | ✅ Complete |
| 3 | Polish & Cleanup | ✅ Complete |
| 4 | Optional Hardening | ✅ Complete |

---

## Git Commit Messages

### Phase 1:
```
refactor: centralize task parsing + improve matching logic

- Create src/utils/TaskParser.ts with shared cleaning/parsing/matching
- Refactor all 4 services to use TaskParser (removes ~200 lines duplication)
- Replace line-number-only matching with multi-signal approach
  (cleanText + priority + lineNumber, 2+ signals = match)
- Increase default debounce 2000ms → 3500ms
- Increase max debounce slider 5000ms → 10000ms

Files changed: TaskParser.ts (new), 4 services refactored, settings.ts
```

### Phase 2:
```
perf: implement incremental scanning for file changes

- Add scanFile() method for single-file scanning
- FileWatcherService now passes changed file to sync callback
- Skip excluded files at watcher level (early bailout)
- Fix stale cache: skip hasListItems() for incremental scans
- Fix taskLimit: only apply to full vault scans, not incremental

Performance: file edits now scan 1 file instead of entire vault
Files changed: TaskScannerService, FileWatcherService, main.ts
```

### Phase 3:
```
chore: add debug logging toggle and cleanup memory leaks

- Add enableDebugLogging setting with UI toggle
- Gate verbose console logs behind debug setting
- Add 300ms debounce to section header input
- Validate debounceMs on load (clamp 500-10000)
- Fix event listener cleanup in stopServices()

Files changed: settings.ts, main.ts, DailyNoteService.ts, ReverseSyncService.ts
```

### Phase 4 (current):
```
chore: add error handling, sync notice, fix task duplication bug

- Remove /g global flags from unused regex constants
- Add try/catch to all file operations (12 total across 4 services)
- Gate all debug/warn logs behind enableDebugLogging setting
- Add sync status Notice toast when tasks are added
- Fix task duplication on checkbox toggle (include completed tasks in dedup)

Files changed: constants.ts, main.ts, DailyNoteService.ts, 
TaskScannerService.ts, ReverseSyncService.ts, SourceToDailySyncService.ts
```

---

## 2026-04-03 - Task Links Refactor (Multi-Connection System)

**Focus:** Implement the full Task Links refactor plan (`docs/Task Links Refactor Plan.md`) — evolving the plugin from a single-purpose priority task scanner into a multi-connection task syncing system.

### Completed (all 9 phases from the refactor plan):

#### Phase 1: Data Model & Migration
- ✅ Created `src/models/TaskLink.ts` — discriminated union: `PriorityScanLink | NoteMirrorLink`
- ✅ Renamed `PriorityTask` → `SyncableTask`, `cleanText` → `displayText`, added `linkId`, optional `priority`, `indent`
- ✅ Deleted `src/models/PriorityTask.ts`
- ✅ Settings migration (version 0→1) converts old flat format to `taskLinks[]` array
- ✅ `PluginSettings` simplified: `{ settingsVersion, enabled, debounceMs, enableDebugLogging, taskLinks[] }`

#### Phase 2: DailyNoteService Multi-Section Support
- ✅ `appendNewTasks(dailyNote, tasks, link)` — section-aware, per-link formatting
- ✅ `findSectionBoundaries(content, links)` — returns `Map<linkId, {start, contentStart, contentEnd}>`
- ✅ `findSectionInsertPoint` — handles plain headings and callout headers
- ✅ `formatTask` — priority-scan gets wikilink+emoji, note-mirror gets plain text with preserved indentation
- ✅ Collapsible callout support: `> [!type]- Header` / `> [!type]+ Header` with auto-creation from plain heading

#### Phase 3: NoteMirrorScannerService
- ✅ Created `src/services/NoteMirrorScannerService.ts`
- ✅ Scans a single source note for tasks, filtered by sourceSections, excludeEmoji, filterTags, includeCompleted

#### Phase 4: FileWatcher Refactor
- ✅ `pendingLinkIds: Set<string>` tracks affected links during debounce
- ✅ `getAffectedLinkIds(file)` routes files to the correct links
- ✅ Shared `pluginModifiedFiles: Set<string>` guard replaces per-service `isProcessing` flags

#### Phase 5: Bidirectional Sync for Multiple Connections
- ✅ `ReverseSyncService.startWatching(dailyNote, links[])` — section-scoped ownership via `findSectionBoundaries`
- ✅ `SourceToDailySyncService.startWatching(dailyNote, links[])` — link-type-aware matching cache
- ✅ Both services use `pluginModifiedFiles` shared guard

#### Phase 6: Settings UI Overhaul
- ✅ Per-link collapsible `<details>` sections in settings
- ✅ Add/remove note-mirror links, section header uniqueness validation
- ✅ Configurable callout type per link

#### Phase 7: Full Sync + Daily Note Creation
- ✅ `syncAllLinks()` iterates enabled links sequentially
- ✅ Daily note creation handler triggers sync + reverse sync setup
- ✅ `restartServices()` for settings changes

#### Phase 8: Collapsible Callout Rendering
- ✅ Callout auto-creation: plain heading → `> [!type]- HeaderText` on first sync
- ✅ Callout prefix handling in task formatting and parsing

#### Phase 9: Polish
- ✅ Dedup, append-only invariant, debug logging throughout
- ✅ Vault rename/delete handlers for note-mirror source paths
- ✅ Manual sync command renamed to "Sync all task links now"

### Bugs Fixed During Testing:

1. **Section header not found** — `vault.read()` reads from disk while editor changes are in Obsidian's in-memory cache. Fixed by using `vault.cachedRead()` in `appendNewTasks`.
2. **Collapsible section matching** — `findHeaderLine` only searched for callout syntax `> [!todo]- Header` and didn't fall back to plain heading `## Header`. Fixed with fallback logic and auto-creation of callout on first insert.
3. **Callout checkbox regex** — `CHECKBOX_REGEX`, `UNCOMPLETED_CHECKBOX_REGEX`, `COMPLETED_CHECKBOX_REGEX` required lines to start with `\s*-`, so callout lines `> - [ ]` never matched. Updated all three to accept optional `> ` prefix.
4. **Completion metadata in matching** — Tasks plugin appends `✅ 2026-04-03` when checking a task. `trimCheckbox()` didn't strip this, causing match failures in reverse sync. Fixed by stripping `✅` and completion dates in both `trimCheckbox()` and `cleanTaskText()`.
5. **Subtask indentation lost** — All tasks were rendered at the same level on the daily note. Fixed by capturing `indent` from original line and applying it in `formatTask`.
6. **Tasks plugin callout warning** — Suppressed `console.warn` for the "Tasks cannot add or remove completion dates" message in `onload()`, restored in `onunload()`.

### Files Changed:

**Created:**
- `src/models/TaskLink.ts`
- `src/models/SyncableTask.ts`
- `src/services/NoteMirrorScannerService.ts`

**Deleted:**
- `src/models/PriorityTask.ts`

**Rewritten:**
- `main.ts`, `src/settings.ts`, `src/services/DailyNoteService.ts`, `src/services/FileWatcherService.ts`, `src/services/ReverseSyncService.ts`, `src/services/SourceToDailySyncService.ts`

**Updated:**
- `src/constants.ts`, `src/utils/TaskParser.ts`, `src/services/TaskScannerService.ts`

### Testing Notes:

- ✅ Build passes with zero TypeScript errors
- ✅ Priority-scan link: vault scan, dedup, bidirectional sync all working
- ✅ Note-mirror link: source note scan, section filtering, bidirectional sync all working
- ✅ Subtask indentation preserved on daily note
- ✅ Settings migration from old format works correctly
- ✅ Deployed and tested on test vault
