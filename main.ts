import { Notice, Plugin, TAbstractFile, TFile } from 'obsidian';
import { TaskScannerService } from './src/services/TaskScannerService';
import { DailyNoteService } from './src/services/DailyNoteService';
import { ReverseSyncService } from './src/services/ReverseSyncService';
import { SourceToDailySyncService } from './src/services/SourceToDailySyncService';
import { FileWatcherService } from './src/services/FileWatcherService';
import { NoteMirrorScannerService } from './src/services/NoteMirrorScannerService';
import { PluginSettings, DEFAULT_SETTINGS, TaskSyncSettingTab, migrateSettings } from './src/settings';
import { SyncableTask } from './src/models/SyncableTask';
import { TaskLink, PriorityScanLink, NoteMirrorLink } from './src/models/TaskLink';

export default class TaskSyncPlugin extends Plugin {
    settings!: PluginSettings;

    /** Shared processing guard — file paths currently being written by the plugin */
    pluginModifiedFiles: Set<string> = new Set();

    private taskScanner!: TaskScannerService;
    private dailyNoteService!: DailyNoteService;
    private reverseSyncService!: ReverseSyncService;
    private sourceToDailyService!: SourceToDailySyncService;
    private fileWatcher!: FileWatcherService;
    private noteMirrorScanner!: NoteMirrorScannerService;
    private createEventRef: import('obsidian').EventRef | null = null;
    private renameEventRef: import('obsidian').EventRef | null = null;
    private deleteEventRef: import('obsidian').EventRef | null = null;
    private originalConsoleWarn: typeof console.warn | null = null;

    async onload(): Promise<void> {
        await this.loadSettings();

        if (this.settings.enableDebugLogging) {
            console.log('[TaskSync] Loading plugin');
        }

        // Suppress obsidian-tasks-plugin callout warning in Live Preview
        this.originalConsoleWarn = console.warn;
        const origWarn = this.originalConsoleWarn;
        console.warn = function (...args: unknown[]) {
            if (typeof args[0] === 'string' && args[0].includes('Tasks cannot add or remove completion dates')) {
                return;
            }
            origWarn.apply(console, args);
        };

        // Initialize services
        this.taskScanner = new TaskScannerService(this.app, this.settings);
        this.dailyNoteService = new DailyNoteService(this.app, this.settings);
        this.reverseSyncService = new ReverseSyncService(this.app, this.dailyNoteService, this.settings, this.pluginModifiedFiles);
        this.sourceToDailyService = new SourceToDailySyncService(this.app, this.dailyNoteService, this.settings, this.pluginModifiedFiles);
        this.noteMirrorScanner = new NoteMirrorScannerService(this.app, this.settings);

        // Set up file watcher
        this.fileWatcher = new FileWatcherService(
            this.app,
            this.settings,
            (file: TFile | undefined, linkIds: Set<string>) => this.handleSyncTrigger(file, linkIds),
            () => this.dailyNoteService.getTodaysDailyNotePath(),
            this.pluginModifiedFiles
        );

        // Start services after Obsidian workspace is fully ready
        if (this.settings.enabled) {
            if (this.app.workspace.layoutReady) {
                await this.startServices();
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
            id: 'sync-all-task-links',
            name: 'Sync all task links now',
            callback: () => this.syncAllLinks(),
        });
    }

    async onunload(): Promise<void> {
        this.stopServices();

        // Restore original console.warn
        if (this.originalConsoleWarn) {
            console.warn = this.originalConsoleWarn;
            this.originalConsoleWarn = null;
        }

        if (this.settings.enableDebugLogging) {
            console.log('[TaskSync] Plugin unloaded');
        }
    }

    /**
     * Start all watching services.
     */
    async startServices(): Promise<void> {
        this.fileWatcher?.start();

        // Listen for daily note creation
        this.createEventRef = this.app.vault.on('create', async (file) => {
            if (file instanceof TFile && file.path.endsWith('.md')) {
                const dailyNotePath = this.dailyNoteService.getTodaysDailyNotePath();
                if (dailyNotePath && file.path === dailyNotePath) {
                    setTimeout(async () => {
                        await this.syncAllLinks();
                        await this.initializeReverseSync();
                    }, 500);
                }
            }
        });
        this.registerEvent(this.createEventRef);

        // Handle source note renames
        this.renameEventRef = this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
            if (!(file instanceof TFile)) return;
            let changed = false;
            for (const link of this.settings.taskLinks) {
                if (link.type === 'note-mirror' && link.sourceNotePath === oldPath) {
                    link.sourceNotePath = file.path;
                    changed = true;
                    if (this.settings.enableDebugLogging) {
                        console.log(`[TaskSync] Updated note-mirror source path: ${oldPath} → ${file.path}`);
                    }
                }
            }
            if (changed) {
                this.saveSettings();
            }
        });
        this.registerEvent(this.renameEventRef);

        // Handle source note deletions
        this.deleteEventRef = this.app.vault.on('delete', (file: TAbstractFile) => {
            if (!(file instanceof TFile)) return;
            let changed = false;
            for (const link of this.settings.taskLinks) {
                if (link.type === 'note-mirror' && link.sourceNotePath === file.path) {
                    link.enabled = false;
                    changed = true;
                    new Notice(`Task Sync: Disabled mirror for "${link.sectionHeader}" — source note was deleted`);
                    if (this.settings.enableDebugLogging) {
                        console.log(`[TaskSync] Disabled note-mirror "${link.sectionHeader}" — source deleted: ${file.path}`);
                    }
                }
            }
            if (changed) {
                this.saveSettings();
            }
        });
        this.registerEvent(this.deleteEventRef);

        await this.syncAllLinks();
        await this.initializeReverseSync();
    }

    /**
     * Stop all watching services.
     */
    stopServices(): void {
        this.fileWatcher?.stop();
        this.reverseSyncService?.stopWatching();
        this.sourceToDailyService?.stopWatching();

        if (this.createEventRef) {
            this.app.vault.offref(this.createEventRef);
            this.createEventRef = null;
        }
        if (this.renameEventRef) {
            this.app.vault.offref(this.renameEventRef);
            this.renameEventRef = null;
        }
        if (this.deleteEventRef) {
            this.app.vault.offref(this.deleteEventRef);
            this.deleteEventRef = null;
        }
    }

    /**
     * Restart all services and sync. Called when settings change.
     */
    async restartServices(): Promise<void> {
        this.stopServices();
        if (this.settings.enabled) {
            await this.startServices();
        }
    }

    /**
     * Sync ALL enabled task links sequentially.
     */
    async syncAllLinks(): Promise<void> {
        if (!this.settings.enabled) return;

        const dailyNote = await this.dailyNoteService.getTodaysDailyNote();
        if (!dailyNote) return;

        for (const link of this.settings.taskLinks) {
            if (!link.enabled) continue;

            if (link.type === 'priority-scan') {
                await this.syncPriorityScanLink(link, dailyNote);
            } else if (link.type === 'note-mirror') {
                await this.syncNoteMirrorLink(link, dailyNote);
            }
        }
    }

    /**
     * Handle sync trigger from FileWatcher.
     */
    private async handleSyncTrigger(file: TFile | undefined, linkIds: Set<string>): Promise<void> {
        if (!this.settings.enabled) return;

        const dailyNote = await this.dailyNoteService.getTodaysDailyNote();
        if (!dailyNote) return;

        for (const linkId of linkIds) {
            const link = this.settings.taskLinks.find(l => l.id === linkId);
            if (!link || !link.enabled) continue;

            if (link.type === 'priority-scan') {
                await this.syncPriorityScanLink(link, dailyNote, file);
            } else if (link.type === 'note-mirror') {
                await this.syncNoteMirrorLink(link, dailyNote);
            }
        }
    }

    /**
     * Sync a priority-scan link.
     */
    private async syncPriorityScanLink(link: PriorityScanLink, dailyNote: TFile, file?: TFile): Promise<void> {
        const allTasks = await this.taskScanner.scanVault(file);

        // Tag tasks with linkId
        for (const task of allTasks) {
            task.linkId = link.id;
        }

        // Filter by priority settings
        const filteredTasks = allTasks.filter(t => {
            if (t.priority === 'highest' && link.includeHighest) return true;
            if (t.priority === 'high' && link.includeHigh) return true;
            return false;
        });

        // Apply task limit only for full vault scans
        const limitedTasks = (!file && link.taskLimit > 0)
            ? filteredTasks.slice(0, link.taskLimit)
            : filteredTasks;

        const count = await this.dailyNoteService.appendNewTasks(dailyNote, limitedTasks, link);
        if (count > 0) {
            new Notice(`Task Sync: Added ${count} task${count > 1 ? 's' : ''}`);
        }
    }

    /**
     * Sync a note-mirror link.
     */
    private async syncNoteMirrorLink(link: NoteMirrorLink, dailyNote: TFile): Promise<void> {
        const tasks = await this.noteMirrorScanner.scanSourceNote(link);

        // Apply task limit
        const limitedTasks = (link.taskLimit > 0)
            ? tasks.slice(0, link.taskLimit)
            : tasks;

        const count = await this.dailyNoteService.appendNewTasks(dailyNote, limitedTasks, link);
        if (count > 0) {
            new Notice(`Task Sync: Added ${count} mirrored task${count > 1 ? 's' : ''}`);
        }
    }

    /**
     * Initialize reverse sync watching for all links with bidirectional sync enabled.
     */
    private async initializeReverseSync(): Promise<void> {
        const enabledLinks = this.settings.taskLinks.filter(l => l.enabled && l.enableBidirectionalSync);
        if (enabledLinks.length === 0) return;

        const dailyNote = await this.dailyNoteService.getTodaysDailyNote();
        if (dailyNote) {
            await this.reverseSyncService.startWatching(dailyNote, enabledLinks);
            await this.sourceToDailyService.startWatching(dailyNote, enabledLinks);
        }
    }

    async loadSettings(): Promise<void> {
        const data = await this.loadData();
        this.settings = migrateSettings(data);

        // Validate debounceMs (clamp to 500-10000)
        if (this.settings.debounceMs < 500) {
            this.settings.debounceMs = 500;
        } else if (this.settings.debounceMs > 10000) {
            this.settings.debounceMs = 10000;
        }

        // Save migrated settings if they were converted
        if (!data || !data.settingsVersion || data.settingsVersion < 1) {
            await this.saveData(this.settings);
        }
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
