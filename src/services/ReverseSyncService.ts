import { App, TFile, EventRef } from 'obsidian';
import { DailyNoteService } from './DailyNoteService';
import { TaskParser, TaskState } from '../utils/TaskParser';
import { CHECKBOX_REGEX } from '../constants';

/**
 * Service for two-way checkbox sync between daily note and source files.
 * Detects checkbox changes in daily note and syncs to source files.
 * Handles both checking AND unchecking (bidirectional).
 */
export class ReverseSyncService {
    /** Cached task states for comparison */
    private taskStateCache: Map<number, TaskState> = new Map();
    private eventRef: EventRef | null = null;
    private dailyNotePath: string | null = null;
    private isProcessing: boolean = false;

    constructor(
        private app: App,
        private dailyNoteService: DailyNoteService
    ) { }

    /**
     * Start watching the daily note for checkbox changes.
     * Called when plugin loads or daily note changes.
     */
    async startWatching(dailyNote: TFile): Promise<void> {
        this.dailyNotePath = dailyNote.path;

        // Build initial cache using TaskParser
        const content = await this.app.vault.read(dailyNote);
        this.taskStateCache = TaskParser.parseAllTaskStates(content, this.app);

        // Set up file watcher for daily note only
        this.eventRef = this.app.vault.on('modify', async (file) => {
            if (file instanceof TFile && file.path === this.dailyNotePath) {
                await this.handleDailyNoteModified(file);
            }
        });
    }

    /**
     * Stop watching (cleanup on unload).
     */
    stopWatching(): void {
        if (this.eventRef) {
            this.app.vault.offref(this.eventRef);
            this.eventRef = null;
        }
        this.taskStateCache.clear();
        this.dailyNotePath = null;
    }

    /**
     * Handle daily note modification.
     * Uses multi-signal matching to detect checkbox toggles.
     */
    async handleDailyNoteModified(file: TFile): Promise<void> {
        // Prevent re-entry during our own modifications
        if (this.isProcessing) {
            return;
        }

        const content = await this.app.vault.read(file);
        const newState = TaskParser.parseAllTaskStates(content, this.app);

        // Find checkboxes that changed using multi-signal matching
        const changedTasks = TaskParser.findChangedTasks(this.taskStateCache, newState);

        if (changedTasks.length > 0) {
            this.isProcessing = true;
            try {
                for (const { state, nowChecked } of changedTasks) {
                    await this.syncToggleToSource(state, nowChecked);
                }
            } finally {
                this.isProcessing = false;
            }
        }

        // Update cache to new state
        this.taskStateCache = newState;
    }

    /**
     * Update the source file to match the daily note checkbox state.
     * Finds matching line by cleanText and sets checkbox accordingly.
     * 
     * @param state - The task state from daily note
     * @param checked - Whether to check or uncheck the source task
     */
    async syncToggleToSource(state: TaskState, checked: boolean): Promise<boolean> {
        if (!state.sourcePath) {
            console.debug('[TaskSync] No source path found in line, skipping reverse sync');
            return false;
        }

        // Get source file
        const sourceFile = this.app.vault.getAbstractFileByPath(state.sourcePath);
        if (!(sourceFile instanceof TFile)) {
            console.debug(`[TaskSync] Source file not found: ${state.sourcePath}`);
            return false;
        }

        // Read source file content
        const content = await this.app.vault.read(sourceFile);
        const lines = content.split('\n');

        // Find matching task line by cleanText
        let matchedIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!TaskParser.isCheckbox(line)) continue;

            const lineCleanText = TaskParser.cleanTaskText(line);
            if (lineCleanText === state.cleanText) {
                matchedIndex = i;
                break;
            }
        }

        if (matchedIndex === -1) {
            console.debug(`[TaskSync] No matching task found in source for: ${state.cleanText}`);
            return false;
        }

        // Update the checkbox state in source
        const oldLine = lines[matchedIndex];
        let newLine: string;
        if (checked) {
            newLine = oldLine.replace(/^(\s*-\s*)\[ \]/, '$1[x]');
        } else {
            newLine = oldLine.replace(/^(\s*-\s*)\[[xX]\]/, '$1[ ]');
        }

        if (oldLine === newLine) {
            console.debug('[TaskSync] Source line already in correct state');
            return false;
        }

        // Write back to source file
        lines[matchedIndex] = newLine;
        await this.app.vault.modify(sourceFile, lines.join('\n'));

        console.debug(`[TaskSync] Synced ${checked ? 'check' : 'uncheck'} to ${state.sourcePath}`);
        return true;
    }
}
