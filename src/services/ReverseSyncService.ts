import { App, TFile, EventRef } from 'obsidian';
import { CheckboxState } from '../models/PriorityTask';
import { DailyNoteService } from './DailyNoteService';
import {
    CHECKBOX_REGEX,
    PRIORITY_REGEX,
    WIKILINK_REGEX,
} from '../constants';

/**
 * Service for two-way checkbox sync between daily note and source files.
 * Detects checkbox changes in daily note and syncs to source files.
 * Handles both checking AND unchecking (bidirectional).
 */
export class ReverseSyncService {
    /** Cached checkbox states for comparison */
    private checkboxCache: Map<number, CheckboxState> = new Map();
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

        // Build initial cache
        const content = await this.app.vault.read(dailyNote);
        this.checkboxCache = this.parseCheckboxStates(content);

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
        this.checkboxCache.clear();
        this.dailyNotePath = null;
    }

    /**
     * Handle daily note modification.
     * Compares new content against cached state to detect toggles.
     */
    async handleDailyNoteModified(file: TFile): Promise<void> {
        // Prevent re-entry during our own modifications
        if (this.isProcessing) {
            return;
        }

        const content = await this.app.vault.read(file);
        const newState = this.parseCheckboxStates(content);

        // Find checkboxes that changed
        const changedCheckboxes = this.findChangedCheckboxes(this.checkboxCache, newState);

        if (changedCheckboxes.length > 0) {
            this.isProcessing = true;
            try {
                for (const { state, nowChecked } of changedCheckboxes) {
                    await this.syncToggleToSource(state, nowChecked);
                }
            } finally {
                this.isProcessing = false;
            }
        }

        // Update cache to new state
        this.checkboxCache = newState;
    }

    /**
     * Build checkbox state cache from file content.
     * Called on initial load and after each modification.
     */
    private parseCheckboxStates(content: string): Map<number, CheckboxState> {
        const states = new Map<number, CheckboxState>();
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const checkboxMatch = line.match(CHECKBOX_REGEX);

            if (checkboxMatch) {
                const checked = checkboxMatch[2].toLowerCase() === 'x';
                const sourcePath = this.extractSourcePath(line);
                const cleanText = this.cleanTaskText(line);

                console.debug(`[TaskSync] Parsed checkbox at line ${i}: checked=${checked}, sourcePath="${sourcePath}", line="${line.substring(0, 80)}..."`);

                states.set(i, {
                    lineNumber: i,
                    checked,
                    cleanText,
                    sourcePath,
                });
            }
        }

        return states;
    }

    /**
     * Find checkboxes that changed state (in either direction).
     * Returns lines where checked state differs between old and new.
     */
    private findChangedCheckboxes(
        oldState: Map<number, CheckboxState>,
        newState: Map<number, CheckboxState>
    ): { state: CheckboxState; nowChecked: boolean }[] {
        const changes: { state: CheckboxState; nowChecked: boolean }[] = [];

        // Look for changes in checkboxes that exist in both states
        for (const [lineNum, newCheckbox] of newState) {
            const oldCheckbox = oldState.get(lineNum);

            if (oldCheckbox && oldCheckbox.checked !== newCheckbox.checked) {
                // Checkbox state changed!
                changes.push({
                    state: newCheckbox,
                    nowChecked: newCheckbox.checked,
                });
            }
        }

        return changes;
    }

    /**
     * Update the source file to match the daily note checkbox state.
     * Finds matching line by cleanText and sets checkbox accordingly.
     * 
     * @param state - The checkbox state from daily note
     * @param checked - Whether to check or uncheck the source task
     */
    async syncToggleToSource(state: CheckboxState, checked: boolean): Promise<boolean> {
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
            const checkboxMatch = line.match(CHECKBOX_REGEX);
            if (checkboxMatch) {
                const lineCleanText = this.cleanTaskText(line);
                if (lineCleanText === state.cleanText) {
                    matchedIndex = i;
                    break;
                }
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

    /**
     * Extract source path from wikilink in line.
     * e.g., "[[Work/Reports]]" → "Work/Reports.md"
     */
    private extractSourcePath(line: string): string | null {
        // Reset regex lastIndex
        WIKILINK_REGEX.lastIndex = 0;
        const match = WIKILINK_REGEX.exec(line);

        if (!match) {
            return null;
        }

        let linkTarget = match[1];

        // Handle aliased links [[path|display]]
        if (linkTarget.includes('|')) {
            linkTarget = linkTarget.split('|')[0];
        }

        // Add .md extension if not present
        if (!linkTarget.endsWith('.md')) {
            linkTarget += '.md';
        }

        return linkTarget;
    }

    /**
     * Clean task text for matching (should match DailyNoteService logic).
     * Strips all metadata added by Tasks plugin and this plugin.
     */
    private cleanTaskText(line: string): string {
        let cleaned = line;

        // Remove checkbox prefix
        cleaned = cleaned.replace(/^\s*-\s*\[[ xX]\]\s*/, '');

        // Remove priority emojis (⏫ 🔺 🔼 🔽 ⏬)
        cleaned = cleaned.replace(PRIORITY_REGEX, '');

        // Remove Tasks plugin metadata:
        // ✅ Done date, 📅 Due date, ⏳ Scheduled, 🛫 Start, 🔁 Recurrence, ➕ Created
        cleaned = cleaned.replace(/[✅📅⏳🛫🔁➕]\s*\d{4}-\d{2}-\d{2}/g, '');

        // Remove standalone completion emoji (sometimes without date)
        cleaned = cleaned.replace(/✅/g, '');

        // Remove wikilinks entirely (these are source file refs we added)
        cleaned = cleaned.replace(/\[\[[^\]]+\]\]/g, '');

        // Remove markdown links entirely [text](url)
        cleaned = cleaned.replace(/\[[^\]]+\]\([^)]+\)/g, '');

        // Normalize whitespace
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        return cleaned;
    }
}
