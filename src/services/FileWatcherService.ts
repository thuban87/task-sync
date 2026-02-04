import { App, TFile, EventRef } from 'obsidian';
import { PluginSettings } from '../settings';

/**
 * Service for debounced file watching and sync triggering.
 * Critical: Ignores the daily note to prevent sync loops.
 */
export class FileWatcherService {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private eventRef: EventRef | null = null;

    constructor(
        private app: App,
        private settings: PluginSettings,
        private onSync: () => Promise<void>,
        private getDailyNotePath: () => string | null
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

        console.debug('[TaskSync] FileWatcher started');
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

        console.debug('[TaskSync] FileWatcher stopped');
    }

    /**
     * Handle file modification event.
     * Ignores daily note. Debounces rapid changes.
     */
    private handleModify(file: TFile): void {
        // Skip if sync shouldn't trigger for this file
        if (!this.shouldTriggerSync(file)) {
            return;
        }

        // Clear existing debounce timer
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        // Set new debounce timer
        this.debounceTimer = setTimeout(async () => {
            this.debounceTimer = null;
            try {
                await this.onSync();
            } catch (error) {
                console.error('[TaskSync] Sync failed:', error);
            }
        }, this.settings.debounceMs);
    }

    /**
     * Check if file should trigger a sync.
     * Returns false for daily note (loop prevention).
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

        return true;
    }
}
