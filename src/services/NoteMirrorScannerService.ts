import { App, TFile } from 'obsidian';
import { SyncableTask } from '../models/SyncableTask';
import { NoteMirrorLink } from '../models/TaskLink';
import { PluginSettings } from '../settings';
import { TaskParser } from '../utils/TaskParser';

/**
 * Service for scanning a source note and producing SyncableTask[] for note-mirror connections.
 */
export class NoteMirrorScannerService {
    constructor(
        private app: App,
        private settings: PluginSettings
    ) { }

    /**
     * Scan a source note for tasks based on the link configuration.
     */
    async scanSourceNote(link: NoteMirrorLink): Promise<SyncableTask[]> {
        if (!link.sourceNotePath) {
            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] No source note path configured for link "${link.sectionHeader}"`);
            }
            return [];
        }

        const file = this.app.vault.getAbstractFileByPath(link.sourceNotePath);
        if (!(file instanceof TFile)) {
            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] Source note not found: ${link.sourceNotePath}`);
            }
            return [];
        }

        // Fast bail-out: skip if source note has no list items
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache && (!cache.listItems || cache.listItems.length === 0)) {
            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] Source note has no list items: ${link.sourceNotePath}`);
            }
            return [];
        }

        try {
            const content = await this.app.vault.cachedRead(file);
            return this.parseContent(content, link);
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to read source note ${link.sourceNotePath}:`, error);
            }
            return [];
        }
    }

    private parseContent(content: string, link: NoteMirrorLink): SyncableTask[] {
        const lines = content.split('\n');
        const tasks: SyncableTask[] = [];

        // Determine which lines to include based on sourceSections filter
        const includedLines = this.getIncludedLines(lines, link.sourceSections);

        for (const lineIndex of includedLines) {
            const line = lines[lineIndex];

            // Must be a checkbox
            if (!TaskParser.isCheckbox(line)) continue;

            // Exclude completed tasks unless configured to include them
            if (!link.includeCompleted && TaskParser.isCompleted(line)) continue;

            // Exclude tasks with the exclude emoji
            if (link.excludeEmoji && TaskParser.containsEmoji(line, link.excludeEmoji)) continue;

            // Filter by tags (if configured)
            if (link.filterTags.length > 0) {
                const taskTags = TaskParser.extractTags(line);
                const hasMatchingTag = link.filterTags.some(ft => taskTags.includes(ft));
                if (!hasMatchingTag) continue;
            }

            // Capture indentation from original line
            const indentMatch = line.match(/^(\s*)/);
            const indent = indentMatch ? indentMatch[1] : '';

            tasks.push({
                originalLine: line,
                displayText: TaskParser.trimCheckbox(line),
                filePath: link.sourceNotePath,
                lineNumber: lineIndex,
                linkId: link.id,
                indent,
            });
        }

        return tasks;
    }

    /**
     * Get the set of line indices that fall within the specified sections.
     * If sourceSections is empty, all lines are included.
     */
    private getIncludedLines(lines: string[], sourceSections: string[]): number[] {
        // If no section filter, include all lines
        if (sourceSections.length === 0) {
            return lines.map((_, i) => i);
        }

        const included: number[] = [];

        for (const sectionHeader of sourceSections) {
            const sectionLevel = this.getHeaderLevel(sectionHeader);
            const headerIndex = lines.findIndex(line => line.trim() === sectionHeader.trim());

            if (headerIndex === -1) continue;

            // Include lines from after header until next heading of same or higher level
            for (let i = headerIndex + 1; i < lines.length; i++) {
                const level = this.getHeaderLevel(lines[i]);
                if (level > 0 && level <= sectionLevel) break;
                included.push(i);
            }
        }

        return included;
    }

    private getHeaderLevel(line: string): number {
        const match = line.match(/^(#{1,6})\s/);
        return match ? match[1].length : 0;
    }
}
