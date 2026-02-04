import { App, TFile, EventRef } from 'obsidian';
import { DailyNoteService } from './DailyNoteService';
import { PRIORITY_REGEX, CHECKBOX_REGEX } from '../constants';

/**
 * Service for syncing task completion from source files to daily note.
 * When a synced task in a source file is checked/unchecked, update the daily note.
 */
export class SourceToDailySyncService {
    private eventRef: EventRef | null = null;
    private dailyNotePath: string | null = null;
    private isProcessing = false;

    // Cache of synced tasks: maps cleanText -> { sourcePath, lineInDaily }
    private syncedTasksCache: Map<string, { sourcePath: string; checked: boolean }> = new Map();

    constructor(
        private app: App,
        private dailyNoteService: DailyNoteService
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

        const content = await this.app.vault.read(dailyNote);
        const lines = content.split('\n');

        for (const line of lines) {
            // Match checkboxes
            const isCheckbox = CHECKBOX_REGEX.test(line);
            if (!isCheckbox) continue;

            // Extract source path from wikilink
            const wikilinkMatch = line.match(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/);
            if (!wikilinkMatch) continue;

            const sourcePath = this.resolveSourcePath(wikilinkMatch[1]);
            if (!sourcePath) continue;

            // Get clean text for matching
            const cleanText = this.cleanTaskText(line);
            const isChecked = /^\s*-\s*\[x\]/i.test(line);

            this.syncedTasksCache.set(cleanText, {
                sourcePath,
                checked: isChecked
            });
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

        // Read the source file and check task states
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');

        const changes: { cleanText: string; nowChecked: boolean }[] = [];

        for (const [cleanText, info] of tasksInFile) {
            // Find this task in the source file
            for (const line of lines) {
                if (!CHECKBOX_REGEX.test(line)) continue;
                if (!PRIORITY_REGEX.test(line)) continue;

                const lineClean = this.cleanTaskText(line);
                if (lineClean === cleanText) {
                    const isNowChecked = /^\s*-\s*\[x\]/i.test(line);
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
    }

    /**
     * Update a task in the daily note.
     */
    private async updateDailyNoteTask(cleanText: string, checked: boolean): Promise<void> {
        if (!this.dailyNotePath) return;

        const dailyNote = this.app.vault.getAbstractFileByPath(this.dailyNotePath);
        if (!(dailyNote instanceof TFile)) return;

        const content = await this.app.vault.read(dailyNote);
        const lines = content.split('\n');
        let modified = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!CHECKBOX_REGEX.test(line)) continue;

            const lineClean = this.cleanTaskText(line);
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
    }

    /**
     * Resolve a wikilink to a full file path.
     */
    private resolveSourcePath(linkText: string): string | null {
        // Handle display text: [[path|display]] -> path
        const path = linkText.split('|')[0];

        // Try to find the file
        const file = this.app.metadataCache.getFirstLinkpathDest(path, '');
        return file?.path ?? null;
    }

    /**
     * Clean task text for matching.
     */
    private cleanTaskText(line: string): string {
        let cleaned = line;

        // Remove checkbox prefix
        cleaned = cleaned.replace(/^\s*-\s*\[[ xX]\]\s*/, '');

        // Remove priority emojis
        cleaned = cleaned.replace(PRIORITY_REGEX, '');

        // Remove Tasks plugin metadata
        cleaned = cleaned.replace(/[✅📅⏳🛫🔁➕]\s*\d{4}-\d{2}-\d{2}/g, '');
        cleaned = cleaned.replace(/✅/g, '');

        // Remove wikilinks entirely
        cleaned = cleaned.replace(/\[\[[^\]]+\]\]/g, '');

        // Remove markdown links
        cleaned = cleaned.replace(/\[[^\]]+\]\([^)]+\)/g, '');

        // Normalize whitespace
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        return cleaned;
    }
}
