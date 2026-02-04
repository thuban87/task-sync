# Task Sync Plugin - Polish Implementation Roadmap

> **Created:** 2026-02-03  
> **Status:** Ready for Implementation

This document outlines the refactoring and polish work for the Task Sync plugin, broken into 4 independent sessions.

---

## Overview

| Phase | Focus | Est. Time | Priority |
|-------|-------|-----------|----------|
| 1 | Foundation Refactoring (TaskParser.ts) | 30-45 min | 🔴 High |
| 2 | Incremental Scanning | 20-30 min | 🔴 High |
| 3 | Polish & Cleanup | 20-30 min | 🟡 Medium |
| 4 | Optional Hardening | 30-45 min | 🟢 Low |

---

## Phase 1: Foundation Refactoring

**Goal:** Eliminate 4x duplication of cleaning logic and add robust task matching.

### Tasks

- [ ] Create `src/utils/TaskParser.ts` with shared logic
- [ ] Move `cleanTaskText()` to TaskParser (currently duplicated in 4 files)
- [ ] Move `extractPriority()` to TaskParser
- [ ] Move `extractSourcePath()` to TaskParser  
- [ ] Add `matchTasks()` function for reconciliation (cleanText + priority + line signals)
- [ ] Refactor `TaskScannerService.ts` to use TaskParser
- [ ] Refactor `DailyNoteService.ts` to use TaskParser
- [ ] Refactor `ReverseSyncService.ts` to use TaskParser
- [ ] Refactor `SourceToDailySyncService.ts` to use TaskParser
- [ ] Update imports and verify build passes
- [ ] Test two-way sync still works

### Files to Create

```
src/utils/TaskParser.ts
```

### Files to Modify

```
src/services/TaskScannerService.ts
src/services/DailyNoteService.ts
src/services/ReverseSyncService.ts
src/services/SourceToDailySyncService.ts
```

### Implementation Notes

**TaskParser.ts Structure:**
```typescript
export class TaskParser {
    // Shared cleaning - strips checkbox, priority, metadata, links
    static cleanTaskText(line: string): string;
    
    // Extract priority level from line
    static extractPriority(line: string): 'highest' | 'high' | null;
    
    // Extract source path from wikilink
    static extractSourcePath(line: string): string | null;
    
    // Check if line is uncompleted checkbox
    static isUncompleted(line: string): boolean;
    
    // Check if line is completed checkbox
    static isCompleted(line: string): boolean;
    
    // Match tasks using multiple signals (for reconciliation)
    static matchTasks(
        oldTasks: Map<string, TaskState>,
        newTasks: Map<string, TaskState>
    ): TaskMatch[];
}
```

**Matching Logic (replaces line-number-only approach):**
- Compare cleanText (strong signal)
- Compare priority emoji (supporting signal)
- Compare line number (weak signal)
- 2+ signals match = same task

### Verification

1. `npm run build` passes
2. Create task in source file → appears in daily note
3. Check task in daily note → source file updates
4. Check task in source file → daily note updates
5. Add new line above task → sync still works (tests new matching)

---

## Phase 2: Incremental Scanning

**Goal:** Only scan files that changed instead of full vault scan.

### Tasks

- [ ] Modify `TaskScannerService.scanVault()` to accept optional `file?: TFile`
- [ ] Add `scanFile(file: TFile)` method for single-file scanning
- [ ] Update `FileWatcherService` to pass changed file to scanner
- [ ] Add exclusion check to `FileWatcherService.shouldTriggerSync()`
- [ ] Test that excluded files don't trigger scans
- [ ] Test that non-excluded file changes only scan that file

### Files to Modify

```
src/services/TaskScannerService.ts
src/services/FileWatcherService.ts
main.ts (update sync call to pass file)
```

### Implementation Notes

**TaskScannerService changes:**
```typescript
// New single-file scan method
async scanFile(file: TFile): Promise<PriorityTask[]> {
    if (this.isExcluded(file)) return [];
    if (!this.hasListItems(file)) return [];
    return this.parseFile(file);
}

// Modify scanVault to optionally scan single file
async scanVault(file?: TFile): Promise<PriorityTask[]> {
    if (file) {
        return this.scanFile(file);
    }
    // ... existing full vault scan
}
```

**FileWatcherService changes:**
```typescript
private shouldTriggerSync(file: TFile): boolean {
    if (!file.path.endsWith('.md')) return false;
    
    // Skip daily note
    const dailyNotePath = this.getDailyNotePath();
    if (dailyNotePath && file.path === dailyNotePath) return false;
    
    // NEW: Skip excluded files
    if (this.isExcluded(file)) return false;
    
    return true;
}

// Pass the file to the sync callback
private handleModify(file: TFile): void {
    // ... debounce logic ...
    await this.onSync(file);  // Pass file instead of no args
}
```

### Verification

1. Edit excluded file → no console activity, no scan
2. Edit non-excluded file → only that file scanned (check debug logs)
3. Full vault scan still works on plugin load and daily note creation
4. Performance feels snappier on large vaults

---

## Phase 3: Polish & Cleanup

**Goal:** Clean up rough edges, fix memory leaks, add debug toggle.

### Tasks

- [ ] Add `enableDebugLogging` setting to `PluginSettings`
- [ ] Gate verbose logs behind debug setting
- [ ] Keep troubleshooting logs (section not found, sync errors)
- [ ] Add debounce to section header text input (300ms)
- [ ] Validate `debounceMs` on settings load (clamp to 500-5000)
- [ ] Clean up suggestions dropdown event listeners in settings
- [ ] Clean up `create` event listener in `stopServices()`
- [ ] Test all changes

### Files to Modify

```
src/settings.ts
main.ts
src/services/ReverseSyncService.ts (gate debug logs)
src/services/DailyNoteService.ts (gate debug logs)
src/services/SourceToDailySyncService.ts (gate debug logs)
```

### Implementation Notes

**Debug Setting:**
```typescript
// settings.ts
export interface PluginSettings {
    // ... existing ...
    enableDebugLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
    // ... existing ...
    enableDebugLogging: false,
};
```

**Gating Logs:**
```typescript
// Before (verbose - gate this)
console.debug(`[TaskSync] Parsed checkbox at line ${i}...`);

// After
if (this.settings.enableDebugLogging) {
    console.debug(`[TaskSync] Parsed checkbox at line ${i}...`);
}

// Keep these ungated (troubleshooting)
console.debug('[TaskSync] Section header not found...');
```

**Section Header Debounce:**
```typescript
// settings.ts - add debounce timer
private sectionHeaderDebounce: ReturnType<typeof setTimeout> | null = null;

// In the onChange handler:
.onChange((value) => {
    if (this.sectionHeaderDebounce) {
        clearTimeout(this.sectionHeaderDebounce);
    }
    this.sectionHeaderDebounce = setTimeout(async () => {
        this.plugin.settings.sectionHeader = value;
        await this.plugin.saveSettings();
    }, 300);
})
```

**Event Listener Cleanup:**
```typescript
// main.ts
private createEventRef: EventRef | null = null;

startServices(): void {
    // Store the ref
    this.createEventRef = this.app.vault.on('create', ...);
    this.registerEvent(this.createEventRef);
}

stopServices(): void {
    // Clean up
    if (this.createEventRef) {
        this.app.vault.offref(this.createEventRef);
        this.createEventRef = null;
    }
    // ... existing cleanup
}
```

### Verification

1. Debug setting OFF → no verbose logs in console
2. Debug setting ON → verbose logs appear
3. Type quickly in section header → only one save after stopping
4. Open/close settings with suggestions visible → no console errors
5. Toggle enabled setting → no lingering event handlers

---

## Phase 4: Optional Hardening

**Goal:** TypeScript strictness, regex fixes, user feedback, error handling.

### Tasks

- [ ] Enable `"strict": true` in tsconfig.json
- [ ] Fix any resulting TypeScript errors
- [ ] Fix regex global flag usage (create fresh instances or remove /g)
- [ ] Add simple sync status notice ("Synced X tasks")
- [ ] Add try/catch to file read/write operations
- [ ] Test error scenarios (delete file during sync, etc.)

### Files to Modify

```
tsconfig.json
src/constants.ts (regex fixes)
src/services/*.ts (error handling, regex usage)
main.ts (status notice)
```

### Implementation Notes

**tsconfig.json:**
```json
{
    "compilerOptions": {
        "strict": true,
        // ... rest
    }
}
```

**Regex Fix Options:**

Option A - Remove global flag where not needed:
```typescript
// constants.ts
export const PRIORITY_REGEX = /[⏫🔺]/;  // No /g
```

Option B - Create fresh instances:
```typescript
// In services
const priorityRegex = new RegExp(PRIORITY_REGEX.source, 'g');
```

**Sync Notice:**
```typescript
// main.ts - after sync completes
import { Notice } from 'obsidian';

const count = await this.dailyNoteService.appendNewTasks(dailyNote, limitedTasks);
if (count > 0) {
    new Notice(`Task Sync: Added ${count} task${count > 1 ? 's' : ''}`);
}
```

**Error Handling Pattern:**
```typescript
try {
    const content = await this.app.vault.read(file);
    // ... process
} catch (error) {
    console.error(`[TaskSync] Failed to read ${file.path}:`, error);
    return; // Graceful degradation
}
```

### Verification

1. `npm run build` passes with strict mode
2. No runtime errors from regex issues
3. Notice appears when tasks sync
4. Delete source file during sync → no crash, graceful message

---

## Session Prompts

Copy-paste these to start each session:

### Session 1 Prompt
```
Continue work on Task Sync plugin polish.

Focus: Phase 1 - Foundation Refactoring
- Create src/utils/TaskParser.ts with shared cleaning/matching logic
- Refactor all 4 services to use TaskParser
- Replace line-number matching with multi-signal reconciliation

Reference: docs/Polish Implementation Roadmap.md
```

### Session 2 Prompt
```
Continue work on Task Sync plugin polish.

Focus: Phase 2 - Incremental Scanning
- Modify TaskScannerService to support single-file scanning
- Update FileWatcherService to pass changed file and check exclusions
- Goal: Only scan files that actually changed

Reference: docs/Polish Implementation Roadmap.md
```

### Session 3 Prompt
```
Continue work on Task Sync plugin polish.

Focus: Phase 3 - Polish & Cleanup
- Add enableDebugLogging setting and gate verbose logs
- Add debounce to section header input
- Clean up event listeners and memory leaks

Reference: docs/Polish Implementation Roadmap.md
```

### Session 4 Prompt
```
Continue work on Task Sync plugin polish.

Focus: Phase 4 - Optional Hardening
- Enable TypeScript strict mode
- Fix regex global flag issues
- Add sync status notice
- Add error handling to file operations

Reference: docs/Polish Implementation Roadmap.md
```

---

## Completed Phases

Mark phases complete here as work progresses:

- [x] Phase 1: Foundation Refactoring
- [ ] Phase 2: Incremental Scanning
- [ ] Phase 3: Polish & Cleanup
- [ ] Phase 4: Optional Hardening
