import { App, TFile } from 'obsidian';
import { PriorityTask } from '../models/PriorityTask';
import { PluginSettings } from '../settings';
import { TaskParser } from '../utils/TaskParser';

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
    isExcluded(file: TFile): boolean {
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
            if (!TaskParser.isUncompleted(line)) {
                continue;
            }

            // Check for priority marker
            const priority = TaskParser.extractPriority(line);
            if (!priority) {
                continue;
            }

            tasks.push({
                originalLine: line,
                cleanText: TaskParser.cleanTaskText(line),
                filePath: file.path,
                lineNumber: i,
                priority,
            });
        }

        return tasks;
    }
}
