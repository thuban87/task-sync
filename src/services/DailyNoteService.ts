import { App, TFile } from 'obsidian';
import { getDailyNote, getAllDailyNotes } from 'obsidian-daily-notes-interface';
import { PriorityTask, SyncedTask } from '../models/PriorityTask';
import { PluginSettings } from '../settings';
import { PRIORITY_MARKERS, CHECKBOX_REGEX } from '../constants';
import { TaskParser } from '../utils/TaskParser';

/**
 * Service for reading from and appending to the daily note.
 */
export class DailyNoteService {
    constructor(
        private app: App,
        private settings: PluginSettings
    ) { }

    /**
     * Get today's daily note file.
     * @returns TFile or null if not found
     */
    async getTodaysDailyNote(): Promise<TFile | null> {
        try {
            const dailyNotes = getAllDailyNotes();
            const todayNote = getDailyNote(window.moment(), dailyNotes);

            if (!todayNote) {
                console.debug('[TaskSync] No daily note found for today');
                return null;
            }

            return todayNote;
        } catch (error) {
            console.warn('[TaskSync] Could not access daily notes. Is the Daily Notes core plugin enabled?', error);
            return null;
        }
    }

    /**
     * Get the path of today's daily note (for FileWatcher loop prevention).
     * @returns Path string or null if not found
     */
    getTodaysDailyNotePath(): string | null {
        try {
            const dailyNotes = getAllDailyNotes();
            const todayNote = getDailyNote(window.moment(), dailyNotes);
            return todayNote?.path ?? null;
        } catch (error) {
            // Silently fail - daily notes may not be configured
            return null;
        }
    }

    /**
     * Append new tasks to the target section.
     * Only appends tasks not already present (by cleanText match).
     * 
     * @param dailyNote - The daily note file
     * @param tasks - Tasks to potentially append
     * @returns Number of tasks actually appended
     */
    async appendNewTasks(dailyNote: TFile, tasks: PriorityTask[]): Promise<number> {
        const content = await this.app.vault.read(dailyNote);

        // Find where to insert
        const insertPoint = this.findSectionInsertPoint(content);
        if (insertPoint === null) {
            console.debug(`[TaskSync] Section header "${this.settings.sectionHeader}" not found in daily note`);
            return 0;
        }

        // Get existing synced tasks for deduplication
        // Only consider UNCOMPLETED tasks - completed tasks should not block new syncs
        const existingTasks = await this.readExistingTasks(dailyNote);
        const existingCleanTexts = new Set(
            existingTasks.filter(t => !t.completed).map(t => t.cleanText)
        );

        // Filter to only new tasks
        const newTasks = tasks.filter(t => !existingCleanTexts.has(t.cleanText));
        if (newTasks.length === 0) {
            console.debug('[TaskSync] No new tasks to sync');
            return 0;
        }

        // Format tasks for insertion
        const formattedTasks = newTasks.map(t => this.formatTask(t, dailyNote));
        const taskBlock = formattedTasks.join('\n') + '\n';

        // Insert at the found position
        const newContent = content.slice(0, insertPoint) + taskBlock + content.slice(insertPoint);
        await this.app.vault.modify(dailyNote, newContent);

        console.debug(`[TaskSync] Appended ${newTasks.length} new tasks`);
        return newTasks.length;
    }

    /**
     * Read existing synced tasks from the target section.
     * Used for deduplication.
     */
    async readExistingTasks(dailyNote: TFile): Promise<SyncedTask[]> {
        const content = await this.app.vault.read(dailyNote);
        const lines = content.split('\n');
        const tasks: SyncedTask[] = [];

        // Find the section
        const sectionIndex = lines.findIndex(line =>
            line.trim() === this.settings.sectionHeader.trim()
        );

        if (sectionIndex === -1) {
            return tasks;
        }

        // Parse tasks in section until next header or end of file
        for (let i = sectionIndex + 1; i < lines.length; i++) {
            const line = lines[i];

            // Stop at next header
            if (line.trim().startsWith('#')) {
                break;
            }

            // Check if this is a checkbox line
            const checkboxMatch = line.match(CHECKBOX_REGEX);
            if (checkboxMatch) {
                const completed = checkboxMatch[2].toLowerCase() === 'x';
                tasks.push({
                    cleanText: TaskParser.cleanTaskText(line),
                    line,
                    completed,
                    lineNumber: i,
                });
            }
        }

        return tasks;
    }

    /**
     * Find section boundaries in file content.
     * Locates the header and determines where to append.
     * @returns Insert position or null if header not found
     */
    private findSectionInsertPoint(content: string): number | null {
        const lines = content.split('\n');

        // Find the section header
        const headerIndex = lines.findIndex(line =>
            line.trim() === this.settings.sectionHeader.trim()
        );

        if (headerIndex === -1) {
            return null;
        }

        // Insert point should be right after the header line
        // Calculate byte offset to end of header line (including newline)
        let offset = 0;
        for (let i = 0; i <= headerIndex; i++) {
            offset += lines[i].length + 1; // +1 for newline
        }

        return offset;
    }

    /**
     * Format a task for insertion into daily note.
     * Uses app.fileManager.generateMarkdownLink() for vault-aware links.
     * Format: - [ ] {cleanText} {priorityEmoji} {link}
     * 
     * @param task - The priority task to format
     * @param dailyNote - The daily note (needed for relative link generation)
     */
    private formatTask(task: PriorityTask, dailyNote: TFile): string {
        const sourceFile = this.app.vault.getAbstractFileByPath(task.filePath);

        // Generate link using Obsidian's native API
        let link = '';
        if (sourceFile instanceof TFile) {
            link = this.app.fileManager.generateMarkdownLink(sourceFile, dailyNote.path);
        } else {
            // Fallback to simple wikilink if file not found
            const basename = task.filePath.replace(/\.md$/, '');
            link = `[[${basename}]]`;
        }

        // Get priority emoji
        const priorityEmoji = task.priority === 'highest'
            ? PRIORITY_MARKERS.highest
            : PRIORITY_MARKERS.high;

        return `- [ ] ${task.cleanText} ${priorityEmoji} ${link}`;
    }
}
