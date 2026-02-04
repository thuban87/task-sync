import { App, TFile } from 'obsidian';
import { PriorityTask } from '../models/PriorityTask';
import { PluginSettings } from '../settings';
import {
    PRIORITY_MARKERS,
    PRIORITY_REGEX,
    UNCOMPLETED_CHECKBOX_REGEX,
    WIKILINK_REGEX,
} from '../constants';

/**
 * Service for scanning the vault for high-priority tasks.
 * Uses metadataCache to skip files without list items for performance.
 */
export class TaskScannerService {
    constructor(
        private app: App,
        private settings: PluginSettings
    ) { }

    /**
     * Scan entire vault for uncompleted priority tasks.
     * Uses metadataCache to skip files without list items.
     * @returns Array of PriorityTask objects, sorted by priority (highest first)
     */
    async scanVault(): Promise<PriorityTask[]> {
        const allTasks: PriorityTask[] = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            // Skip excluded files
            if (this.isExcluded(file)) {
                continue;
            }

            // Skip files without list items (performance optimization)
            if (!this.hasListItems(file)) {
                continue;
            }

            const tasks = await this.parseFile(file);
            allTasks.push(...tasks);
        }

        // Sort by priority (highest first)
        return allTasks.sort((a, b) => {
            if (a.priority === 'highest' && b.priority !== 'highest') return -1;
            if (a.priority !== 'highest' && b.priority === 'highest') return 1;
            return 0;
        });
    }

    /**
     * Check if file is excluded by settings.
     */
    private isExcluded(file: TFile): boolean {
        // Check excluded folders
        for (const folder of this.settings.excludedFolders) {
            if (folder && file.path.startsWith(folder + '/')) {
                return true;
            }
            // Also match root folder
            if (folder && file.path.startsWith(folder)) {
                return true;
            }
        }

        // Check excluded files (full path)
        for (const excludedFile of this.settings.excludedFiles) {
            if (excludedFile && file.path === excludedFile) {
                return true;
            }
        }

        // Check excluded file names (matches in any directory)
        for (const fileName of this.settings.excludedFileNames) {
            if (fileName && file.name === fileName) {
                return true;
            }
        }

        return false;
    }

    /**
     * Check if file has list items via cache (fast).
     * @returns True if file might contain tasks
     */
    private hasListItems(file: TFile): boolean {
        const cache = this.app.metadataCache.getFileCache(file);
        return cache?.listItems !== undefined && cache.listItems.length > 0;
    }

    /**
     * Parse a single file for priority tasks.
     * Only called if hasListItems() returns true.
     */
    private async parseFile(file: TFile): Promise<PriorityTask[]> {
        const tasks: PriorityTask[] = [];
        const content = await this.app.vault.read(file);
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Skip if not an uncompleted checkbox
            if (!this.isUncompleted(line)) {
                continue;
            }

            // Check for priority marker
            const priority = this.extractPriority(line);
            if (!priority) {
                continue;
            }

            tasks.push({
                originalLine: line,
                cleanText: this.cleanTaskText(line),
                filePath: file.path,
                lineNumber: i,
                priority,
            });
        }

        return tasks;
    }

    /**
     * Extract priority level from task line.
     * @returns 'highest' (⏫), 'high' (🔺), or null
     */
    private extractPriority(line: string): 'highest' | 'high' | null {
        if (line.includes(PRIORITY_MARKERS.highest)) {
            return 'highest';
        }
        if (line.includes(PRIORITY_MARKERS.high)) {
            return 'high';
        }
        return null;
    }

    /**
     * Clean task text for deduplication.
     * Strips: checkbox, priority emoji, wikilinks, Tasks plugin metadata, extra whitespace.
     */
    private cleanTaskText(line: string): string {
        let cleaned = line;

        // Remove checkbox prefix (- [ ] or - [x])
        cleaned = cleaned.replace(/^\s*-\s*\[[ xX]\]\s*/, '');

        // Remove priority emojis (⏫ 🔺 🔼 🔽 ⏬)
        cleaned = cleaned.replace(PRIORITY_REGEX, '');

        // Remove Tasks plugin metadata:
        // ✅ Done date, 📅 Due date, ⏳ Scheduled, 🛫 Start, 🔁 Recurrence, ➕ Created
        cleaned = cleaned.replace(/[✅📅⏳🛫🔁➕]\s*\d{4}-\d{2}-\d{2}/g, '');

        // Remove standalone completion emoji (sometimes without date)
        cleaned = cleaned.replace(/✅/g, '');

        // Remove wikilinks entirely (for consistent matching)
        cleaned = cleaned.replace(/\[\[[^\]]+\]\]/g, '');

        // Remove markdown links entirely [text](url)
        cleaned = cleaned.replace(/\[[^\]]+\]\([^)]+\)/g, '');

        // Normalize whitespace
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        return cleaned;
    }

    /**
     * Check if task line is uncompleted.
     */
    private isUncompleted(line: string): boolean {
        return UNCOMPLETED_CHECKBOX_REGEX.test(line);
    }
}
