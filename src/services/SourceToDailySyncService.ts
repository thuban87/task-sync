import { App, TFile, EventRef } from 'obsidian';
import { DailyNoteService } from './DailyNoteService';
import { TaskParser } from '../utils/TaskParser';
import { CHECKBOX_REGEX } from '../constants';
import { PluginSettings } from '../settings';
import { TaskLink, NoteMirrorLink } from '../models/TaskLink';

interface CachedTaskInfo {
    sourcePath: string;
    checked: boolean;
    linkId: string;
    linkType: 'priority-scan' | 'note-mirror';
}

/**
 * Service for syncing task completion from source files to daily note.
 * Supports multiple links with link-type-aware matching.
 */
export class SourceToDailySyncService {
    private eventRef: EventRef | null = null;
    private dailyNotePath: string | null = null;
    private links: TaskLink[] = [];

    // Cache: displayText → CachedTaskInfo
    private syncedTasksCache: Map<string, CachedTaskInfo> = new Map();

    constructor(
        private app: App,
        private dailyNoteService: DailyNoteService,
        private settings: PluginSettings,
        private pluginModifiedFiles: Set<string>
    ) { }

    async startWatching(dailyNote: TFile, links: TaskLink[]): Promise<void> {
        this.stopWatching();
        this.dailyNotePath = dailyNote.path;
        this.links = links;

        await this.buildSyncedTasksCache(dailyNote);

        this.eventRef = this.app.vault.on('modify', async (file) => {
            if (file instanceof TFile && file.path !== this.dailyNotePath) {
                await this.handleSourceFileModified(file);
            }
        });
    }

    stopWatching(): void {
        if (this.eventRef) {
            this.app.vault.offref(this.eventRef);
            this.eventRef = null;
        }
        this.syncedTasksCache.clear();
        this.dailyNotePath = null;
        this.links = [];
    }

    private async buildSyncedTasksCache(dailyNote: TFile): Promise<void> {
        this.syncedTasksCache.clear();

        try {
            const content = await this.app.vault.read(dailyNote);
            const boundaries = this.dailyNoteService.findSectionBoundaries(content, this.links);
            const lines = content.split('\n');

            for (const [linkId, range] of boundaries) {
                const link = this.links.find(l => l.id === linkId);
                if (!link) continue;

                for (let i = range.contentStart; i <= range.contentEnd; i++) {
                    let line = lines[i];

                    // Strip callout prefix if collapsible
                    if (link.collapsible) {
                        line = TaskParser.stripCalloutPrefix(line);
                    }

                    if (!TaskParser.isCheckbox(line)) continue;

                    const isChecked = TaskParser.isCompleted(line);
                    let sourcePath: string;
                    let displayText: string;

                    if (link.type === 'priority-scan') {
                        // Source from wikilink
                        const extracted = TaskParser.extractSourcePath(line, this.app);
                        if (!extracted) continue;
                        sourcePath = extracted;
                        displayText = TaskParser.cleanTaskText(line);
                    } else {
                        // Source from link config
                        sourcePath = (link as NoteMirrorLink).sourceNotePath;
                        displayText = TaskParser.trimCheckbox(line);
                    }

                    this.syncedTasksCache.set(displayText, {
                        sourcePath,
                        checked: isChecked,
                        linkId: link.id,
                        linkType: link.type,
                    });
                }
            }
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn('[TaskSync] Failed to build synced tasks cache:', error);
            }
        }
    }

    private async handleSourceFileModified(file: TFile): Promise<void> {
        // Skip if the plugin just wrote to this file
        if (this.pluginModifiedFiles.has(file.path)) return;

        const tasksInFile = Array.from(this.syncedTasksCache.entries())
            .filter(([_, info]) => info.sourcePath === file.path);

        if (tasksInFile.length === 0) return;

        try {
            const content = await this.app.vault.read(file);
            const lines = content.split('\n');

            const changes: { displayText: string; nowChecked: boolean }[] = [];

            for (const [displayText, info] of tasksInFile) {
                for (const line of lines) {
                    if (!TaskParser.isCheckbox(line)) continue;

                    // For priority-scan: require priority emoji
                    if (info.linkType === 'priority-scan') {
                        if (!TaskParser.extractPriority(line)) continue;
                        const lineDisplayText = TaskParser.cleanTaskText(line);
                        if (lineDisplayText === displayText) {
                            const isNowChecked = TaskParser.isCompleted(line);
                            if (isNowChecked !== info.checked) {
                                changes.push({ displayText, nowChecked: isNowChecked });
                            }
                            break;
                        }
                    } else {
                        // For note-mirror: match by trimCheckbox text
                        const lineDisplayText = TaskParser.trimCheckbox(line);
                        if (lineDisplayText === displayText) {
                            const isNowChecked = TaskParser.isCompleted(line);
                            if (isNowChecked !== info.checked) {
                                changes.push({ displayText, nowChecked: isNowChecked });
                            }
                            break;
                        }
                    }
                }
            }

            if (changes.length === 0) return;

            for (const { displayText, nowChecked } of changes) {
                await this.updateDailyNoteTask(displayText, nowChecked);
                const info = this.syncedTasksCache.get(displayText);
                if (info) {
                    info.checked = nowChecked;
                }
            }
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to handle source file modification ${file.path}:`, error);
            }
        }
    }

    private async updateDailyNoteTask(displayText: string, checked: boolean): Promise<void> {
        if (!this.dailyNotePath) return;

        const dailyNote = this.app.vault.getAbstractFileByPath(this.dailyNotePath);
        if (!(dailyNote instanceof TFile)) return;

        try {
            const content = await this.app.vault.read(dailyNote);
            const lines = content.split('\n');
            let modified = false;

            for (let i = 0; i < lines.length; i++) {
                let line = lines[i];
                const originalLine = line;

                // Strip callout prefix for matching
                const strippedLine = TaskParser.stripCalloutPrefix(line);

                if (!TaskParser.isCheckbox(strippedLine)) continue;

                // Try both cleaning methods for matching
                const cleanedText = TaskParser.cleanTaskText(strippedLine);
                const trimmedText = TaskParser.trimCheckbox(strippedLine);

                if (cleanedText === displayText || trimmedText === displayText) {
                    let newLine: string;
                    if (checked) {
                        newLine = originalLine.replace(/^((?:>\s*)?(?:\s*)-\s*)\[ \]/, '$1[x]');
                    } else {
                        newLine = originalLine.replace(/^((?:>\s*)?(?:\s*)-\s*)\[[xX]\]/, '$1[ ]');
                    }
                    if (newLine !== originalLine) {
                        lines[i] = newLine;
                        modified = true;
                    }
                    break;
                }
            }

            if (modified) {
                // Use shared processing guard
                this.pluginModifiedFiles.add(dailyNote.path);
                await this.app.vault.modify(dailyNote, lines.join('\n'));
                setTimeout(() => this.pluginModifiedFiles.delete(dailyNote.path), 100);
            }
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to update daily note task:`, error);
            }
        }
    }
}
