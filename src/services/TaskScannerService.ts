import { App, TFile } from 'obsidian';
import { SyncableTask } from '../models/SyncableTask';
import { PluginSettings } from '../settings';
import { PriorityScanLink } from '../models/TaskLink';
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
     * Get the priority-scan link's exclusion settings.
     */
    private getPriorityScanLink(): PriorityScanLink | undefined {
        return this.settings.taskLinks.find(
            (l): l is PriorityScanLink => l.type === 'priority-scan'
        );
    }

    async scanVault(file?: TFile): Promise<SyncableTask[]> {
        if (file) {
            return this.scanFile(file);
        }

        const allTasks: SyncableTask[] = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const f of files) {
            if (this.isExcluded(f)) continue;
            if (!this.hasListItems(f)) continue;

            const tasks = await this.parseFile(f);
            allTasks.push(...tasks);
        }

        return allTasks.sort((a, b) => {
            if (a.priority === 'highest' && b.priority !== 'highest') return -1;
            if (a.priority !== 'highest' && b.priority === 'highest') return 1;
            return 0;
        });
    }

    async scanFile(file: TFile): Promise<SyncableTask[]> {
        if (this.isExcluded(file)) {
            if (this.settings.enableDebugLogging) {
                console.log(`[TaskSync] scanFile: ${file.path} is excluded, skipping`);
            }
            return [];
        }
        const tasks = await this.parseFile(file);
        if (this.settings.enableDebugLogging) {
            console.log(`[TaskSync] scanFile: ${file.path} found ${tasks.length} priority tasks`);
        }
        return tasks;
    }

    isExcluded(file: TFile): boolean {
        const link = this.getPriorityScanLink();
        if (!link) return false;

        for (const folder of link.excludedFolders) {
            if (folder && (file.path.startsWith(folder + '/') || file.path.startsWith(folder))) {
                return true;
            }
        }
        for (const excludedFile of link.excludedFiles) {
            if (excludedFile && file.path === excludedFile) {
                return true;
            }
        }
        for (const fileName of link.excludedFileNames) {
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
    private async parseFile(file: TFile): Promise<SyncableTask[]> {
        try {
            const tasks: SyncableTask[] = [];
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
                    displayText: TaskParser.cleanTaskText(line),
                    filePath: file.path,
                    lineNumber: i,
                    priority,
                    linkId: '',
                });
            }

            return tasks;
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to parse file ${file.path}:`, error);
            }
            return [];
        }
    }
}
