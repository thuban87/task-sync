import { App, TFile, EventRef } from 'obsidian';
import { DailyNoteService } from './DailyNoteService';
import { TaskParser } from '../utils/TaskParser';
import { CHECKBOX_REGEX } from '../constants';
import { PluginSettings } from '../settings';

/**
 * Service for syncing task completion from source files to daily note.
 * When a synced task in a source file is checked/unchecked, update the daily note.
 */
export class SourceToDailySyncService {
    private eventRef: EventRef | null = null;
    private dailyNotePath: string | null = null;
    private isProcessing = false;

    // Cache of synced tasks: maps cleanText -> { sourcePath, checked }
    private syncedTasksCache: Map<string, { sourcePath: string; checked: boolean }> = new Map();

    constructor(
        private app: App,
        private dailyNoteService: DailyNoteService,
        private settings: PluginSettings
    ) { }

    /**
     * Start watching source files for changes.
     * @param dailyNote - The daily note file to update
     */
    async startWatching(dailyNote: TFile): Promise<void> {
        this.dailyNotePath = dailyNote.path;

        // Build initial cache of synced tasks from daily note
        await this.buildSyncedTasksCache(dailyNote);

        // Watch for file modifications
        this.eventRef = this.app.vault.on('modify', async (file) => {
            if (file instanceof TFile && file.path !== this.dailyNotePath) {
                // Source file modified, check if it contains synced tasks
                await this.handleSourceFileModified(file);
            }
        });
    }

    /**
     * Stop watching.
     */
    stopWatching(): void {
        if (this.eventRef) {
            this.app.vault.offref(this.eventRef);
            this.eventRef = null;
        }
        this.syncedTasksCache.clear();
        this.dailyNotePath = null;
    }

    /**
     * Build cache of synced tasks from daily note.
     * Extracts tasks that have source file links.
     */
    private async buildSyncedTasksCache(dailyNote: TFile): Promise<void> {
        this.syncedTasksCache.clear();

        try {
            const content = await this.app.vault.read(dailyNote);
            const lines = content.split('\n');

            for (const line of lines) {
                // Match checkboxes
                if (!TaskParser.isCheckbox(line)) continue;

                // Extract source path from wikilink
                const sourcePath = TaskParser.extractSourcePath(line, this.app);
                if (!sourcePath) continue;

                // Get clean text for matching
                const cleanText = TaskParser.cleanTaskText(line);
                const isChecked = TaskParser.isCompleted(line);

                this.syncedTasksCache.set(cleanText, {
                    sourcePath,
                    checked: isChecked
                });
            }
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn('[TaskSync] Failed to build synced tasks cache:', error);
            }
        }
    }

    /**
     * Handle source file modification - check if any synced tasks changed.
     */
    private async handleSourceFileModified(file: TFile): Promise<void> {
        if (this.isProcessing) return;

        // Check if this file has any synced tasks
        const tasksInFile = Array.from(this.syncedTasksCache.entries())
            .filter(([_, info]) => info.sourcePath === file.path);

        if (tasksInFile.length === 0) return;

        try {
            // Read the source file and check task states
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');

            const changes: { cleanText: string; nowChecked: boolean }[] = [];

            for (const [cleanText, info] of tasksInFile) {
                // Find this task in the source file
                for (const line of lines) {
                    if (!TaskParser.isCheckbox(line)) continue;
                    if (!TaskParser.extractPriority(line)) continue;

                    const lineClean = TaskParser.cleanTaskText(line);
                    if (lineClean === cleanText) {
                        const isNowChecked = TaskParser.isCompleted(line);
                        if (isNowChecked !== info.checked) {
                            changes.push({ cleanText, nowChecked: isNowChecked });
                        }
                        break;
                    }
                }
            }

            if (changes.length === 0) return;

            // Apply changes to daily note
            this.isProcessing = true;
            try {
                for (const { cleanText, nowChecked } of changes) {
                    await this.updateDailyNoteTask(cleanText, nowChecked);
                    // Update cache
                    const info = this.syncedTasksCache.get(cleanText);
                    if (info) {
                        info.checked = nowChecked;
                    }
                }
            } finally {
                this.isProcessing = false;
            }
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to handle source file modification ${file.path}:`, error);
            }
        }
    }

    /**
     * Update a task in the daily note.
     */
    private async updateDailyNoteTask(cleanText: string, checked: boolean): Promise<void> {
        if (!this.dailyNotePath) return;

        const dailyNote = this.app.vault.getAbstractFileByPath(this.dailyNotePath);
        if (!(dailyNote instanceof TFile)) return;

        try {
            const content = await this.app.vault.read(dailyNote);
            const lines = content.split('\n');
            let modified = false;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                if (!TaskParser.isCheckbox(line)) continue;

                const lineClean = TaskParser.cleanTaskText(line);
                if (lineClean === cleanText) {
                    // Update the checkbox
                    const oldLine = line;
                    let newLine: string;
                    if (checked) {
                        newLine = oldLine.replace(/^(\s*-\s*)\[ \]/, '$1[x]');
                    } else {
                        newLine = oldLine.replace(/^(\s*-\s*)\[x\]/i, '$1[ ]');
                    }
                    if (newLine !== oldLine) {
                        lines[i] = newLine;
                        modified = true;
                    }
                    break;
                }
            }

            if (modified) {
                await this.app.vault.modify(dailyNote, lines.join('\n'));
            }
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to update daily note task:`, error);
            }
        }
    }
}
