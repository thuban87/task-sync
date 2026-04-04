import { App, TFile } from 'obsidian';
import { getDailyNote, getAllDailyNotes } from 'obsidian-daily-notes-interface';
import { SyncableTask, SyncedTask } from '../models/SyncableTask';
import { PluginSettings } from '../settings';
import { TaskLink } from '../models/TaskLink';
import { PRIORITY_MARKERS, CHECKBOX_REGEX } from '../constants';
import { TaskParser } from '../utils/TaskParser';

/**
 * Service for reading from and appending to the daily note.
 * Supports multiple independent sections via TaskLink configuration.
 */
export class DailyNoteService {
    constructor(
        private app: App,
        private settings: PluginSettings
    ) { }

    async getTodaysDailyNote(): Promise<TFile | null> {
        try {
            const dailyNotes = getAllDailyNotes();
            const todayNote = getDailyNote(window.moment(), dailyNotes);

            if (!todayNote) {
                if (this.settings.enableDebugLogging) {
                    console.debug('[TaskSync] No daily note found for today');
                }
                return null;
            }

            return todayNote;
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn('[TaskSync] Could not access daily notes. Is the Daily Notes core plugin enabled?', error);
            }
            return null;
        }
    }

    getTodaysDailyNotePath(): string | null {
        try {
            const dailyNotes = getAllDailyNotes();
            const todayNote = getDailyNote(window.moment(), dailyNotes);
            return todayNote?.path ?? null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Append new tasks to a specific link's section.
     * Returns 0 if section header not found.
     */
    async appendNewTasks(dailyNote: TFile, tasks: SyncableTask[], link: TaskLink): Promise<number> {
        if (this.settings.enableDebugLogging) {
            console.log(`[TaskSync] appendNewTasks called with ${tasks.length} tasks for "${link.sectionHeader}"`);
        }

        try {
            const content = await this.app.vault.cachedRead(dailyNote);

            if (this.settings.enableDebugLogging) {
                const lines = content.split('\n');
                console.debug(`[TaskSync] Daily note path: ${dailyNote.path}`);
                console.debug(`[TaskSync] Daily note has ${lines.length} lines`);
                console.debug(`[TaskSync] Looking for header: ${JSON.stringify(link.sectionHeader)}`);
                console.debug(`[TaskSync] Collapsible: ${link.collapsible}, calloutType: ${link.calloutType}`);
                const headingLines = lines.map((l, i) => `${i}: ${JSON.stringify(l)}`).filter((_, i) => lines[i].match(/^#|^>/));
                console.debug(`[TaskSync] Heading/callout lines in daily note:`, headingLines);
            }

            const insertResult = this.findSectionInsertPoint(content, link.sectionHeader, link.collapsible, link.calloutType);
            if (insertResult === null) {
                if (this.settings.enableDebugLogging) {
                    console.debug(`[TaskSync] Section header "${link.sectionHeader}" not found in daily note`);
                }
                return 0;
            }

            const { offset: insertPoint, needsCalloutCreation } = insertResult;

            const existingTasks = this.readExistingTasksFromContent(content, link.sectionHeader, link.collapsible, link.calloutType);
            const existingDisplayTexts = new Set(existingTasks.map(t => t.displayText));

            if (this.settings.enableDebugLogging) {
                console.log(`[TaskSync] Found ${existingTasks.length} existing tasks for deduplication`);
            }

            const newTasks = tasks.filter(t => !existingDisplayTexts.has(t.displayText));

            if (this.settings.enableDebugLogging) {
                console.log(`[TaskSync] After deduplication: ${newTasks.length} new tasks to add`);
            }

            if (newTasks.length === 0) {
                return 0;
            }

            const formattedTasks = newTasks.map(t => this.formatTask(t, dailyNote, link));
            let taskBlock = '';

            // If the heading exists but the callout doesn't yet, create it
            if (needsCalloutCreation) {
                const headerText = link.sectionHeader.replace(/^#+\s*/, '');
                taskBlock = `> [!${link.calloutType}]- ${headerText}\n` + formattedTasks.join('\n') + '\n';
            } else {
                taskBlock = formattedTasks.join('\n') + '\n';
            }

            const newContent = content.slice(0, insertPoint) + taskBlock + content.slice(insertPoint);
            await this.app.vault.modify(dailyNote, newContent);

            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] Appended ${newTasks.length} new tasks to "${link.sectionHeader}"`);
            }
            return newTasks.length;
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to append tasks to daily note:`, error);
            }
            return 0;
        }
    }

    /**
     * Read existing synced tasks from a specific section.
     */
    readExistingTasksFromContent(content: string, sectionHeader: string, collapsible: boolean, calloutType: string): SyncedTask[] {
        const lines = content.split('\n');
        const tasks: SyncedTask[] = [];

        const boundaries = this.findSectionLineRange(lines, sectionHeader, collapsible, calloutType);
        if (!boundaries) return tasks;

        for (let i = boundaries.contentStart; i <= boundaries.contentEnd; i++) {
            let line = lines[i];

            // Strip callout prefix if collapsible
            if (collapsible) {
                line = TaskParser.stripCalloutPrefix(line);
            }

            const checkboxMatch = line.match(CHECKBOX_REGEX);
            if (checkboxMatch) {
                const completed = checkboxMatch[2].toLowerCase() === 'x';
                // For note-mirror sections, use trimCheckbox for displayText matching
                // For priority-scan sections, use cleanTaskText
                const displayText = TaskParser.cleanTaskText(line);
                tasks.push({
                    displayText,
                    line: lines[i], // original line with callout prefix
                    completed,
                    lineNumber: i,
                });
            }
        }

        return tasks;
    }

    /**
     * Find section boundaries for all links in the daily note content.
     * Returns a Map of linkId → { start (header line), contentStart, contentEnd }.
     */
    findSectionBoundaries(content: string, links: TaskLink[]): Map<string, { start: number; contentStart: number; contentEnd: number }> {
        const lines = content.split('\n');
        const result = new Map<string, { start: number; contentStart: number; contentEnd: number }>();

        for (const link of links) {
            const range = this.findSectionLineRange(lines, link.sectionHeader, link.collapsible, link.calloutType);
            if (range) {
                result.set(link.id, range);
            }
        }

        return result;
    }

    /**
     * Find section insert point for a specific header.
     * Returns character offset, or null if header not found.
     */
    findSectionInsertPoint(content: string, sectionHeader: string, collapsible: boolean, calloutType: string): { offset: number; needsCalloutCreation: boolean } | null {
        const lines = content.split('\n');
        const headerIndex = this.findHeaderLine(lines, sectionHeader, collapsible, calloutType);

        if (headerIndex === -1) return null;

        const matchedLine = lines[headerIndex];
        const needsCalloutCreation = collapsible && !this.isCalloutLine(matchedLine);

        if (collapsible && this.isCalloutLine(matchedLine)) {
            // Callout already exists - find end of existing callout content
            let lastCalloutLine = headerIndex;
            for (let i = headerIndex + 1; i < lines.length; i++) {
                if (!lines[i].startsWith('> ') && lines[i].trim() !== '>') break;
                lastCalloutLine = i;
            }
            let offset = 0;
            for (let i = 0; i <= lastCalloutLine; i++) {
                offset += lines[i].length + 1;
            }
            return { offset, needsCalloutCreation: false };
        }

        // Insert right after the header line
        let offset = 0;
        for (let i = 0; i <= headerIndex; i++) {
            offset += lines[i].length + 1;
        }

        return { offset, needsCalloutCreation };
    }

    /**
     * Format a task for insertion into daily note.
     * Format depends on link type:
     * - Priority-scan: `- [ ] {displayText} {priorityEmoji} {wikilink}`
     * - Note-mirror: `- [ ] {displayText}`
     * If collapsible, lines are prefixed with `> `.
     */
    private formatTask(task: SyncableTask, dailyNote: TFile, link: TaskLink): string {
        let formatted: string;

        if (link.type === 'priority-scan') {
            const sourceFile = this.app.vault.getAbstractFileByPath(task.filePath);
            let wikilink = '';
            if (sourceFile instanceof TFile) {
                wikilink = this.app.fileManager.generateMarkdownLink(sourceFile, dailyNote.path);
            } else {
                const basename = task.filePath.replace(/\.md$/, '');
                wikilink = `[[${basename}]]`;
            }

            const priorityEmoji = task.priority === 'highest'
                ? PRIORITY_MARKERS.highest
                : PRIORITY_MARKERS.high;

            formatted = `- [ ] ${task.displayText} ${priorityEmoji} ${wikilink}`;
        } else {
            // Note-mirror: preserve original indentation, display text only
            const indent = task.indent ?? '';
            formatted = `${indent}- [ ] ${task.displayText}`;
        }

        // Add callout prefix if collapsible
        if (link.collapsible) {
            formatted = `> ${formatted}`;
        }

        return formatted;
    }

    /**
     * Get the header level of a markdown heading line.
     * Returns 0 if not a heading.
     */
    private getHeaderLevel(line: string): number {
        const match = line.match(/^(#{1,6})\s/);
        return match ? match[1].length : 0;
    }

    /**
     * Find the line index of a section header (plain or callout).
     * When collapsible, tries callout pattern first, then falls back to plain heading.
     */
    private findHeaderLine(lines: string[], sectionHeader: string, collapsible: boolean, calloutType: string): number {
        if (collapsible) {
            // First try callout header: > [!type]- HeaderText or > [!type]+ HeaderText
            const headerText = sectionHeader.replace(/^#+\s*/, '');
            const calloutIndex = lines.findIndex(line => {
                const trimmed = line.trim();
                return trimmed === `> [!${calloutType}]- ${headerText}` ||
                       trimmed === `> [!${calloutType}]+ ${headerText}`;
            });
            if (calloutIndex !== -1) return calloutIndex;

            // Fallback: match the plain heading (callout will be created on first insert)
            return lines.findIndex(line => line.trim() === sectionHeader.trim());
        } else {
            return lines.findIndex(line => line.trim() === sectionHeader.trim());
        }
    }

    /**
     * Check whether the matched header line is already a callout (vs a plain heading).
     */
    private isCalloutLine(line: string): boolean {
        return line.trim().startsWith('> [!');
    }

    /**
     * Find the line range for a section's content.
     * Returns { start (header), contentStart, contentEnd } or null.
     * A section ends at the next heading of same or higher level, or EOF.
     */
    private findSectionLineRange(
        lines: string[],
        sectionHeader: string,
        collapsible: boolean,
        calloutType: string
    ): { start: number; contentStart: number; contentEnd: number } | null {
        const headerIndex = this.findHeaderLine(lines, sectionHeader, collapsible, calloutType);
        if (headerIndex === -1) return null;

        const contentStart = headerIndex + 1;

        if (collapsible) {
            // Callout section: content continues while lines start with `> `
            let contentEnd = contentStart;
            for (let i = contentStart; i < lines.length; i++) {
                if (!lines[i].startsWith('> ') && lines[i].trim() !== '>') {
                    break;
                }
                contentEnd = i;
            }
            // If no content lines found, contentEnd stays at contentStart
            if (contentEnd < contentStart) {
                return { start: headerIndex, contentStart, contentEnd: contentStart - 1 };
            }
            return { start: headerIndex, contentStart, contentEnd };
        } else {
            // Plain header section: ends at next heading of same or higher level
            const sectionLevel = this.getHeaderLevel(sectionHeader);
            let contentEnd = lines.length - 1;
            for (let i = contentStart; i < lines.length; i++) {
                const level = this.getHeaderLevel(lines[i]);
                if (level > 0 && level <= sectionLevel) {
                    contentEnd = i - 1;
                    break;
                }
            }
            return { start: headerIndex, contentStart, contentEnd };
        }
    }
}
