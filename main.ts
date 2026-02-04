import { Notice, Plugin, TFile } from 'obsidian';
import { TaskScannerService } from './src/services/TaskScannerService';
import { DailyNoteService } from './src/services/DailyNoteService';
import { ReverseSyncService } from './src/services/ReverseSyncService';
import { SourceToDailySyncService } from './src/services/SourceToDailySyncService';
import { FileWatcherService } from './src/services/FileWatcherService';
import { PluginSettings, DEFAULT_SETTINGS, TaskSyncSettingTab } from './src/settings';
import { PriorityTask } from './src/models/PriorityTask';

export default class TaskSyncPlugin extends Plugin {
    settings!: PluginSettings;

    private taskScanner!: TaskScannerService;
    private dailyNoteService!: DailyNoteService;
    private reverseSyncService!: ReverseSyncService;
    private sourceToDailyService!: SourceToDailySyncService;
    private fileWatcher!: FileWatcherService;
    private createEventRef: import('obsidian').EventRef | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();

        if (this.settings.enableDebugLogging) {
            console.log('[TaskSync] Loading plugin');
        }

        // Initialize services
        this.taskScanner = new TaskScannerService(this.app, this.settings);
        this.dailyNoteService = new DailyNoteService(this.app, this.settings);
        this.reverseSyncService = new ReverseSyncService(this.app, this.dailyNoteService, this.settings);
        this.sourceToDailyService = new SourceToDailySyncService(this.app, this.dailyNoteService, this.settings);

        // Set up file watcher (passes changed file for incremental scanning)
        this.fileWatcher = new FileWatcherService(
            this.app,
            this.settings,
            (file?: TFile) => this.syncPriorityTasks(file),
            () => this.dailyNoteService.getTodaysDailyNotePath(),
            (file: TFile) => this.taskScanner.isExcluded(file)
        );

        // Start services after Obsidian workspace is fully ready
        if (this.settings.enabled) {
            if (this.app.workspace.layoutReady) {
                this.startServices();
            } else {
                this.app.workspace.onLayoutReady(() => {
                    this.startServices();
                });
            }
        }

        // Settings tab
        this.addSettingTab(new TaskSyncSettingTab(this.app, this));

        // Manual sync command
        this.addCommand({
            id: 'sync-priority-tasks',
            name: 'Sync priority tasks now',
            callback: () => this.syncPriorityTasks(),
        });
    }

    async onunload(): Promise<void> {
        this.stopServices();
        if (this.settings.enableDebugLogging) {
            console.log('[TaskSync] Plugin unloaded');
        }
    }

    /**
     * Start all watching services.
     */
    async startServices(): Promise<void> {
        this.fileWatcher?.start();

        // Listen for daily note creation (store ref for cleanup)
        this.createEventRef = this.app.vault.on('create', async (file) => {
            if (file.path.endsWith('.md')) {
                const dailyNotePath = this.dailyNoteService.getTodaysDailyNotePath();
                if (dailyNotePath && file.path === dailyNotePath) {
                    // Small delay to let the file finish being written
                    setTimeout(async () => {
                        await this.syncPriorityTasks();
                        await this.initializeReverseSync();
                    }, 500);
                }
            }
        });
        this.registerEvent(this.createEventRef);

        await this.initializeReverseSync();
    }

    /**
     * Stop all watching services.
     */
    stopServices(): void {
        this.fileWatcher?.stop();
        this.reverseSyncService?.stopWatching();
        this.sourceToDailyService?.stopWatching();

        // Clean up create event listener
        if (this.createEventRef) {
            this.app.vault.offref(this.createEventRef);
            this.createEventRef = null;
        }
    }

    /**
     * Main sync operation: Vault → Daily Note
     * @param file Optional file for incremental scanning (single file changed)
     */
    private async syncPriorityTasks(file?: TFile): Promise<void> {
        if (!this.settings.enabled) return;

        const dailyNote = await this.dailyNoteService.getTodaysDailyNote();
        if (!dailyNote) {
            return;
        }

        // Scan vault or single file (incremental scanning)
        const allTasks = await this.taskScanner.scanVault(file);

        // Filter by priority settings
        const filteredTasks = this.filterByPriority(allTasks);

        // Apply task limit ONLY for full vault scans
        // For incremental scans, pass all tasks - the limit shouldn't cut off new tasks
        const limitedTasks = (!file && this.settings.taskLimit > 0)
            ? filteredTasks.slice(0, this.settings.taskLimit)
            : filteredTasks;

        // Append new tasks (deduplication handled inside)
        const count = await this.dailyNoteService.appendNewTasks(dailyNote, limitedTasks);
        if (count > 0) {
            new Notice(`Task Sync: Added ${count} task${count > 1 ? 's' : ''}`);
        }
    }

    /**
     * Initialize reverse sync watching.
     */
    private async initializeReverseSync(): Promise<void> {
        if (!this.settings.enableReverseSync) {
            return;
        }

        const dailyNote = await this.dailyNoteService.getTodaysDailyNote();
        if (dailyNote) {
            await this.reverseSyncService.startWatching(dailyNote);
            await this.sourceToDailyService.startWatching(dailyNote);
        }
    }

    private filterByPriority(tasks: PriorityTask[]): PriorityTask[] {
        return tasks.filter(t => {
            if (t.priority === 'highest' && this.settings.includeHighest) return true;
            if (t.priority === 'high' && this.settings.includeHigh) return true;
            return false;
        });
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

        // Validate debounceMs (clamp to 500-10000)
        if (this.settings.debounceMs < 500) {
            this.settings.debounceMs = 500;
        } else if (this.settings.debounceMs > 10000) {
            this.settings.debounceMs = 10000;
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
