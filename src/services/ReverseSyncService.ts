import { App, TFile, EventRef } from 'obsidian';
import { DailyNoteService } from './DailyNoteService';
import { TaskParser, TaskState } from '../utils/TaskParser';
import { CHECKBOX_REGEX } from '../constants';
import { PluginSettings } from '../settings';
import { TaskLink, NoteMirrorLink } from '../models/TaskLink';

/**
 * Service for two-way checkbox sync between daily note and source files.
 * Detects checkbox changes in daily note and syncs to source files.
 * Supports multiple links with section-scoped matching.
 */
export class ReverseSyncService {
    private taskStateCache: Map<number, TaskState> = new Map();
    private eventRef: EventRef | null = null;
    private dailyNotePath: string | null = null;
    private links: TaskLink[] = [];

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

        try {
            const content = await this.app.vault.read(dailyNote);
            this.taskStateCache = TaskParser.parseAllTaskStates(content, this.app);
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn('[TaskSync] Failed to read daily note for reverse sync:', error);
            }
            this.taskStateCache = new Map();
        }

        this.eventRef = this.app.vault.on('modify', async (file) => {
            if (file instanceof TFile && file.path === this.dailyNotePath) {
                await this.handleDailyNoteModified(file);
            }
        });
    }

    stopWatching(): void {
        if (this.eventRef) {
            this.app.vault.offref(this.eventRef);
            this.eventRef = null;
        }
        this.taskStateCache.clear();
        this.dailyNotePath = null;
        this.links = [];
    }

    private async handleDailyNoteModified(file: TFile): Promise<void> {
        // Skip if the plugin just wrote to this file
        if (this.pluginModifiedFiles.has(file.path)) return;

        try {
            const content = await this.app.vault.read(file);
            const newState = TaskParser.parseAllTaskStates(content, this.app);

            const changedTasks = TaskParser.findChangedTasks(this.taskStateCache, newState);

            if (changedTasks.length > 0) {
                // Compute section boundaries to determine link ownership
                const boundaries = this.dailyNoteService.findSectionBoundaries(content, this.links);

                for (const { state, nowChecked } of changedTasks) {
                    const ownerLink = this.findOwnerLink(state.lineNumber, boundaries);
                    if (!ownerLink || !ownerLink.enableBidirectionalSync) continue;

                    if (ownerLink.type === 'priority-scan') {
                        // Use wikilink in task line to find source
                        await this.syncToggleToSource(state, nowChecked);
                    } else if (ownerLink.type === 'note-mirror') {
                        // Use link config for source path
                        await this.syncToggleToSourceByConfig(state, nowChecked, ownerLink as NoteMirrorLink);
                    }
                }
            }

            this.taskStateCache = newState;
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn('[TaskSync] Failed to process daily note modification:', error);
            }
        }
    }

    /**
     * Find which link owns a given line number based on section boundaries.
     */
    private findOwnerLink(lineNumber: number, boundaries: Map<string, { start: number; contentStart: number; contentEnd: number }>): TaskLink | null {
        for (const [linkId, range] of boundaries) {
            if (lineNumber >= range.contentStart && lineNumber <= range.contentEnd) {
                return this.links.find(l => l.id === linkId) ?? null;
            }
        }
        return null;
    }

    /**
     * Sync a toggle to source using wikilink (priority-scan tasks).
     */
    private async syncToggleToSource(state: TaskState, checked: boolean): Promise<boolean> {
        if (!state.sourcePath) {
            if (this.settings.enableDebugLogging) {
                console.debug('[TaskSync] No source path found in line, skipping reverse sync');
            }
            return false;
        }

        const sourceFile = this.app.vault.getAbstractFileByPath(state.sourcePath);
        if (!(sourceFile instanceof TFile)) {
            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] Source file not found: ${state.sourcePath}`);
            }
            return false;
        }

        return this.applyToggleToFile(sourceFile, state.displayText, checked);
    }

    /**
     * Sync a toggle to source using link config (note-mirror tasks).
     * Uses displayText as primary match key, lineNumber as tie-breaker.
     */
    private async syncToggleToSourceByConfig(state: TaskState, checked: boolean, link: NoteMirrorLink): Promise<boolean> {
        const sourceFile = this.app.vault.getAbstractFileByPath(link.sourceNotePath);
        if (!(sourceFile instanceof TFile)) {
            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] Source note not found: ${link.sourceNotePath}`);
            }
            return false;
        }

        // For note-mirror: match using trimCheckbox text (lightly cleaned)
        const dailyDisplayText = TaskParser.stripCalloutPrefix(state.originalLine);
        const displayText = TaskParser.trimCheckbox(dailyDisplayText);

        return this.applyToggleToFile(sourceFile, displayText, checked, state.lineNumber, true);
    }

    /**
     * Apply a checkbox toggle to a matching task in a source file.
     */
    private async applyToggleToFile(
        sourceFile: TFile,
        displayText: string,
        checked: boolean,
        hintLineNumber?: number,
        useTrimCheckbox: boolean = false
    ): Promise<boolean> {
        try {
            const content = await this.app.vault.read(sourceFile);
            const lines = content.split('\n');

            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] applyToggleToFile: looking for "${displayText}" in ${sourceFile.path} (useTrimCheckbox=${useTrimCheckbox})`);
            }

            // Find all matching lines
            const matches: number[] = [];
            for (let i = 0; i < lines.length; i++) {
                if (!TaskParser.isCheckbox(lines[i])) continue;
                const lineText = useTrimCheckbox
                    ? TaskParser.trimCheckbox(lines[i])
                    : TaskParser.cleanTaskText(lines[i]);
                if (lineText === displayText) {
                    matches.push(i);
                }
            }

            if (matches.length === 0) {
                if (this.settings.enableDebugLogging) {
                    console.debug(`[TaskSync] No matching task found in source for: "${displayText}"`);
                    // Log first few source tasks for comparison
                    const sampleSourceTexts = lines
                        .filter(l => TaskParser.isCheckbox(l))
                        .slice(0, 5)
                        .map(l => useTrimCheckbox ? TaskParser.trimCheckbox(l) : TaskParser.cleanTaskText(l));
                    console.debug(`[TaskSync] Sample source texts:`, sampleSourceTexts);
                }
                return false;
            }

            // Pick the best match (closest to hintLineNumber if multiple matches)
            let matchedIndex = matches[0];
            if (matches.length > 1 && hintLineNumber !== undefined) {
                matchedIndex = matches.reduce((closest, idx) =>
                    Math.abs(idx - hintLineNumber) < Math.abs(closest - hintLineNumber) ? idx : closest
                );
            }

            const oldLine = lines[matchedIndex];
            let newLine: string;
            if (checked) {
                newLine = oldLine.replace(/^(\s*-\s*)\[ \]/, '$1[x]');
            } else {
                newLine = oldLine.replace(/^(\s*-\s*)\[[xX]\]/, '$1[ ]');
            }

            if (oldLine === newLine) return false;

            lines[matchedIndex] = newLine;

            // Use shared processing guard
            this.pluginModifiedFiles.add(sourceFile.path);
            await this.app.vault.modify(sourceFile, lines.join('\n'));
            setTimeout(() => this.pluginModifiedFiles.delete(sourceFile.path), 100);

            if (this.settings.enableDebugLogging) {
                console.debug(`[TaskSync] Synced ${checked ? 'check' : 'uncheck'} to ${sourceFile.path}`);
            }
            return true;
        } catch (error) {
            if (this.settings.enableDebugLogging) {
                console.warn(`[TaskSync] Failed to sync toggle to source file ${sourceFile.path}:`, error);
            }
            return false;
        }
    }
}
