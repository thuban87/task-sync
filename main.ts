import { Plugin } from 'obsidian';
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

    async onload(): Promise<void> {
        console.log('[TaskSync] Loading plugin');

        await this.loadSettings();

        // Initialize services
        this.taskScanner = new TaskScannerService(this.app, this.settings);
        this.dailyNoteService = new DailyNoteService(this.app, this.settings);
        this.reverseSyncService = new ReverseSyncService(this.app, this.dailyNoteService);
        this.sourceToDailyService = new SourceToDailySyncService(this.app, this.dailyNoteService);

        // Set up file watcher
        this.fileWatcher = new FileWatcherService(
            this.app,
            this.settings,
            () => this.syncPriorityTasks(),
            () => this.dailyNoteService.getTodaysDailyNotePath()
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
        console.log('[TaskSync] Plugin unloaded');
    }

    /**
     * Start all watching services.
     */
    async startServices(): Promise<void> {
        this.fileWatcher?.start();

        // Listen for daily note creation
        this.registerEvent(
            this.app.vault.on('create', async (file) => {
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
            })
        );

        await this.initializeReverseSync();
    }

    /**
     * Stop all watching services.
     */
    stopServices(): void {
        this.fileWatcher?.stop();
        this.reverseSyncService?.stopWatching();
        this.sourceToDailyService?.stopWatching();
    }

    /**
     * Main sync operation: Vault → Daily Note
     */
    private async syncPriorityTasks(): Promise<void> {
        if (!this.settings.enabled) return;

        const dailyNote = await this.dailyNoteService.getTodaysDailyNote();
        if (!dailyNote) {
            return;
        }

        // Scan vault (uses cache optimization)
        const allTasks = await this.taskScanner.scanVault();

        // Filter by priority settings
        const filteredTasks = this.filterByPriority(allTasks);

        // Apply task limit
        const limitedTasks = this.settings.taskLimit > 0
            ? filteredTasks.slice(0, this.settings.taskLimit)
            : filteredTasks;

        // Append new tasks (deduplication handled inside)
        await this.dailyNoteService.appendNewTasks(dailyNote, limitedTasks);
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
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
