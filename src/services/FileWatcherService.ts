import { App, TFile, EventRef } from 'obsidian';
import { PluginSettings } from '../settings';

/**
 * Service for debounced file watching and sync triggering.
 * Critical: Ignores the daily note to prevent sync loops.
 * Supports incremental scanning by passing the changed file to onSync.
 */
export class FileWatcherService {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private eventRef: EventRef | null = null;
    private pendingFile: TFile | null = null;

    constructor(
        private app: App,
        private settings: PluginSettings,
        private onSync: (file?: TFile) => Promise<void>,
        private getDailyNotePath: () => string | null,
        private isExcluded: (file: TFile) => boolean
    ) { }

    /**
     * Start watching vault for file modifications.
     */
    start(): void {
        this.eventRef = this.app.vault.on('modify', (file) => {
            if (file instanceof TFile) {
                this.handleModify(file);
            }
        });

        if (this.settings.enableDebugLogging) {
            console.debug('[TaskSync] FileWatcher started');
        }
    }

    /**
     * Stop watching and clean up.
     */
    stop(): void {
        if (this.eventRef) {
            this.app.vault.offref(this.eventRef);
            this.eventRef = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.pendingFile = null;

        if (this.settings.enableDebugLogging) {
            console.debug('[TaskSync] FileWatcher stopped');
        }
    }

    /**
     * Handle file modification event.
     * Ignores daily note and excluded files. Debounces rapid changes.
     */
    private handleModify(file: TFile): void {
        // Skip if sync shouldn't trigger for this file
        if (!this.shouldTriggerSync(file)) {
            return;
        }

        // Track the file that triggered this sync
        // If multiple files change during debounce, we'll do a full vault scan
        if (this.pendingFile && this.pendingFile.path !== file.path) {
            // Multiple different files changed - clear pending to trigger full scan
            this.pendingFile = null;
        } else {
            this.pendingFile = file;
        }

        // Clear existing debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Set new debounce timer
        const fileToSync = this.pendingFile;
        this.debounceTimer = setTimeout(async () => {
            this.debounceTimer = null;
            this.pendingFile = null;
            try {
                // Pass the specific file for incremental scan, or undefined for full scan
                if (this.settings.enableDebugLogging) {
                    console.log(`[TaskSync] Triggering sync - incremental: ${fileToSync?.path ?? 'FULL SCAN'}`);
                }
                await this.onSync(fileToSync ?? undefined);
            } catch (error) {
                if (this.settings.enableDebugLogging) {
                    console.error('[TaskSync] Sync failed:', error);
                }
            }
        }, this.settings.debounceMs);
    }

    /**
     * Check if file should trigger a sync.
     * Returns false for daily note (loop prevention) and excluded files.
     */
    private shouldTriggerSync(file: TFile): boolean {
        // Only trigger for markdown files
        if (!file.path.endsWith('.md')) {
            return false;
        }

        // CRITICAL: Ignore daily note to prevent sync loops
        const dailyNotePath = this.getDailyNotePath();
        if (dailyNotePath && file.path === dailyNotePath) {
            return false;
        }

        // Skip excluded files - no need to scan them
        if (this.isExcluded(file)) {
            return false;
        }

        return true;
    }
}
