import { App, TFile, EventRef } from 'obsidian';
import { PluginSettings } from '../settings';
import { PriorityScanLink, NoteMirrorLink } from '../models/TaskLink';

/**
 * Service for debounced file watching and sync triggering.
 * Routes file changes to the correct sync handler based on which TaskLinks are affected.
 */
export class FileWatcherService {
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private eventRef: EventRef | null = null;
    private pendingFile: TFile | null = null;
    private pendingLinkIds: Set<string> = new Set();

    constructor(
        private app: App,
        private settings: PluginSettings,
        private onSync: (file: TFile | undefined, linkIds: Set<string>) => Promise<void>,
        private getDailyNotePath: () => string | null,
        private pluginModifiedFiles: Set<string>
    ) { }

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
        this.pendingLinkIds.clear();

        if (this.settings.enableDebugLogging) {
            console.debug('[TaskSync] FileWatcher stopped');
        }
    }

    private handleModify(file: TFile): void {
        if (!file.path.endsWith('.md')) return;

        // Skip daily note
        const dailyNotePath = this.getDailyNotePath();
        if (dailyNotePath && file.path === dailyNotePath) return;

        // Skip files the plugin just modified (shared processing guard)
        if (this.pluginModifiedFiles.has(file.path)) return;

        // Determine which links are affected by this file change
        const affectedLinkIds = this.getAffectedLinkIds(file);
        if (affectedLinkIds.size === 0) return;

        // Track pending links
        for (const id of affectedLinkIds) {
            this.pendingLinkIds.add(id);
        }

        // Track file for incremental priority scan
        if (this.pendingFile && this.pendingFile.path !== file.path) {
            this.pendingFile = null; // Multiple files → full scan
        } else {
            this.pendingFile = file;
        }

        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }

        const fileToSync = this.pendingFile;
        const linkIdsToSync = new Set(this.pendingLinkIds);

        this.debounceTimer = setTimeout(async () => {
            this.debounceTimer = null;
            this.pendingFile = null;
            this.pendingLinkIds.clear();
            try {
                if (this.settings.enableDebugLogging) {
                    console.log(`[TaskSync] Triggering sync for links: [${[...linkIdsToSync].join(', ')}] - file: ${fileToSync?.path ?? 'FULL SCAN'}`);
                }
                await this.onSync(fileToSync ?? undefined, linkIdsToSync);
            } catch (error) {
                if (this.settings.enableDebugLogging) {
                    console.error('[TaskSync] Sync failed:', error);
                }
            }
        }, this.settings.debounceMs);
    }

    /**
     * Determine which links are affected by a file change.
     */
    private getAffectedLinkIds(file: TFile): Set<string> {
        const ids = new Set<string>();

        for (const link of this.settings.taskLinks) {
            if (!link.enabled) continue;

            if (link.type === 'priority-scan') {
                const psLink = link as PriorityScanLink;
                if (!this.isExcludedByLink(file, psLink)) {
                    ids.add(link.id);
                }
            } else if (link.type === 'note-mirror') {
                const nmLink = link as NoteMirrorLink;
                if (file.path === nmLink.sourceNotePath) {
                    ids.add(link.id);
                }
            }
        }

        return ids;
    }

    /**
     * Check if a file is excluded by a priority-scan link's exclusion settings.
     */
    private isExcludedByLink(file: TFile, link: PriorityScanLink): boolean {
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
}
