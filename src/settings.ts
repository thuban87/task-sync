import { App, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type TaskSyncPlugin from '../main';
import { TaskLink, PriorityScanLink, NoteMirrorLink, DEFAULT_PRIORITY_SCAN_LINK, DEFAULT_NOTE_MIRROR_LINK, generateId } from './models/TaskLink';

/**
 * Plugin settings interface.
 */
export interface PluginSettings {
    settingsVersion: number;
    enabled: boolean;
    debounceMs: number;
    enableDebugLogging: boolean;
    taskLinks: TaskLink[];
}

/**
 * Default settings values.
 */
export const DEFAULT_SETTINGS: PluginSettings = {
    settingsVersion: 1,
    enabled: true,
    debounceMs: 3500,
    enableDebugLogging: false,
    taskLinks: [{ ...DEFAULT_PRIORITY_SCAN_LINK }],
};

/**
 * Migrate old flat settings format to new taskLinks format.
 * Old format (version 0): flat settings with sectionHeader, taskLimit, etc. at top level.
 * New format (version 1): settings with taskLinks[] array.
 */
export function migrateSettings(data: any): PluginSettings {
    if (!data) {
        return { ...DEFAULT_SETTINGS, taskLinks: [{ ...DEFAULT_PRIORITY_SCAN_LINK }] };
    }

    // Already migrated
    if (data.settingsVersion >= 1 && data.taskLinks) {
        return data as PluginSettings;
    }

    // Migrate from version 0 (flat format)
    const priorityScanLink: PriorityScanLink = {
        ...DEFAULT_PRIORITY_SCAN_LINK,
        sectionHeader: data.sectionHeader ?? DEFAULT_PRIORITY_SCAN_LINK.sectionHeader,
        taskLimit: data.taskLimit ?? DEFAULT_PRIORITY_SCAN_LINK.taskLimit,
        enableBidirectionalSync: data.enableReverseSync ?? DEFAULT_PRIORITY_SCAN_LINK.enableBidirectionalSync,
        includeHighest: data.includeHighest ?? DEFAULT_PRIORITY_SCAN_LINK.includeHighest,
        includeHigh: data.includeHigh ?? DEFAULT_PRIORITY_SCAN_LINK.includeHigh,
        excludedFolders: data.excludedFolders ?? DEFAULT_PRIORITY_SCAN_LINK.excludedFolders,
        excludedFiles: data.excludedFiles ?? DEFAULT_PRIORITY_SCAN_LINK.excludedFiles,
        excludedFileNames: data.excludedFileNames ?? DEFAULT_PRIORITY_SCAN_LINK.excludedFileNames,
    };

    return {
        settingsVersion: 1,
        enabled: data.enabled ?? DEFAULT_SETTINGS.enabled,
        debounceMs: data.debounceMs ?? DEFAULT_SETTINGS.debounceMs,
        enableDebugLogging: data.enableDebugLogging ?? DEFAULT_SETTINGS.enableDebugLogging,
        taskLinks: [priorityScanLink],
    };
}

/**
 * Helper to get the first priority-scan link from settings.
 */
export function getPriorityScanLink(settings: PluginSettings): PriorityScanLink | undefined {
    return settings.taskLinks.find((l): l is PriorityScanLink => l.type === 'priority-scan');
}

/**
 * Settings tab UI.
 */
export class TaskSyncSettingTab extends PluginSettingTab {
    plugin: TaskSyncPlugin;
    private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    constructor(app: App, plugin: TaskSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Task Sync Settings' });

        // === Global Settings ===

        new Setting(containerEl)
            .setName('Enable sync')
            .setDesc('Turn task syncing on or off')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enabled)
                .onChange(async (value) => {
                    this.plugin.settings.enabled = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        await this.plugin.restartServices();
                    } else {
                        this.plugin.stopServices();
                    }
                }));

        new Setting(containerEl)
            .setName('Debounce delay')
            .setDesc('How long to wait after file changes before syncing (in milliseconds)')
            .addSlider(slider => slider
                .setLimits(500, 10000, 100)
                .setValue(this.plugin.settings.debounceMs)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.debounceMs = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Enable debug logging')
            .setDesc('Show verbose logs in the developer console (Ctrl+Shift+I)')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableDebugLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableDebugLogging = value;
                    await this.plugin.saveSettings();
                }));

        // === Task Links ===

        containerEl.createEl('h2', { text: 'Task Links' });

        for (let i = 0; i < this.plugin.settings.taskLinks.length; i++) {
            const link = this.plugin.settings.taskLinks[i];
            this.renderTaskLink(containerEl, link, i);
        }

        // Add Note Mirror button
        new Setting(containerEl)
            .addButton(button => button
                .setButtonText('Add Note Mirror')
                .setCta()
                .onClick(async () => {
                    const newLink: NoteMirrorLink = {
                        ...DEFAULT_NOTE_MIRROR_LINK,
                        id: generateId(),
                        sectionHeader: '## New Mirror',
                    };
                    this.plugin.settings.taskLinks.push(newLink);
                    await this.plugin.saveSettings();
                    await this.plugin.restartServices();
                    this.display();
                }));
    }

    private renderTaskLink(containerEl: HTMLElement, link: TaskLink, index: number): void {
        const details = containerEl.createEl('details', { cls: 'task-sync-link-section' });
        details.createEl('summary', {
            text: `${link.type === 'priority-scan' ? '⚡' : '🔗'} ${link.sectionHeader || '(no header)'}`,
            cls: 'task-sync-link-summary',
        });

        const linkContainer = details.createDiv({ cls: 'task-sync-link-settings' });

        // Enabled toggle
        new Setting(linkContainer)
            .setName('Enabled')
            .addToggle(toggle => toggle
                .setValue(link.enabled)
                .onChange(async (value) => {
                    link.enabled = value;
                    await this.plugin.saveSettings();
                    await this.plugin.restartServices();
                }));

        // Section header
        new Setting(linkContainer)
            .setName('Section header')
            .setDesc('The header in your daily note for this link\'s tasks')
            .addText(text => text
                .setPlaceholder('## My Tasks')
                .setValue(link.sectionHeader)
                .onChange((value) => {
                    this.debouncedSave(`header-${link.id}`, async () => {
                        // Validate uniqueness
                        const duplicate = this.plugin.settings.taskLinks.find(
                            (l) => l.id !== link.id && l.sectionHeader === value
                        );
                        if (duplicate) {
                            return; // Don't save duplicate headers
                        }
                        link.sectionHeader = value;
                        await this.plugin.saveSettings();
                    });
                }));

        // Task limit
        new Setting(linkContainer)
            .setName('Task limit')
            .setDesc('Maximum tasks to sync (0 = no limit)')
            .addText(text => text
                .setPlaceholder('0')
                .setValue(String(link.taskLimit))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        link.taskLimit = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // Collapsible toggle
        new Setting(linkContainer)
            .setName('Collapsible')
            .setDesc('Render this section as a collapsible callout')
            .addToggle(toggle => toggle
                .setValue(link.collapsible)
                .onChange(async (value) => {
                    link.collapsible = value;
                    await this.plugin.saveSettings();
                }));

        // Callout type (only visible when collapsible is true)
        if (link.collapsible) {
            new Setting(linkContainer)
                .setName('Callout type')
                .setDesc('The callout type to use (e.g. todo, info, note, tip)')
                .addText(text => text
                    .setPlaceholder('todo')
                    .setValue(link.calloutType)
                    .onChange(async (value) => {
                        link.calloutType = value || 'todo';
                        await this.plugin.saveSettings();
                    }));
        }

        // Bidirectional sync toggle
        new Setting(linkContainer)
            .setName('Bidirectional sync')
            .setDesc('Two-way checkbox sync between daily note and source')
            .addToggle(toggle => toggle
                .setValue(link.enableBidirectionalSync)
                .onChange(async (value) => {
                    link.enableBidirectionalSync = value;
                    await this.plugin.saveSettings();
                    await this.plugin.restartServices();
                }));

        // Type-specific settings
        if (link.type === 'priority-scan') {
            this.renderPriorityScanSettings(linkContainer, link);
        } else {
            this.renderNoteMirrorSettings(linkContainer, link);
        }

        // Remove button (only for note-mirror links)
        if (link.type === 'note-mirror') {
            new Setting(linkContainer)
                .addButton(button => button
                    .setButtonText('Remove this link')
                    .setWarning()
                    .onClick(async () => {
                        this.plugin.settings.taskLinks.splice(index, 1);
                        await this.plugin.saveSettings();
                        await this.plugin.restartServices();
                        this.display();
                    }));
        }
    }

    private renderPriorityScanSettings(containerEl: HTMLElement, link: PriorityScanLink): void {
        containerEl.createEl('h4', { text: 'Priority Filters' });

        new Setting(containerEl)
            .setName('Include highest priority (⏫)')
            .addToggle(toggle => toggle
                .setValue(link.includeHighest)
                .onChange(async (value) => {
                    link.includeHighest = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Include high priority (🔺)')
            .addToggle(toggle => toggle
                .setValue(link.includeHigh)
                .onChange(async (value) => {
                    link.includeHigh = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h4', { text: 'Exclusions' });

        this.renderExclusionList(
            containerEl,
            'Excluded folders',
            'Folders to ignore when scanning',
            link.excludedFolders,
            'folder'
        );

        this.renderExclusionList(
            containerEl,
            'Excluded files',
            'Files to ignore (full path)',
            link.excludedFiles,
            'file'
        );

        this.renderFileNameExclusionList(
            containerEl,
            'Excluded file names',
            'File names to ignore in ANY directory',
            link.excludedFileNames
        );
    }

    private renderNoteMirrorSettings(containerEl: HTMLElement, link: NoteMirrorLink): void {
        // Source note path with autocomplete
        new Setting(containerEl)
            .setName('Source note')
            .setDesc('The note to mirror tasks from')
            .addSearch(search => {
                search
                    .setPlaceholder('Path to source note...')
                    .setValue(link.sourceNotePath);

                const inputEl = search.inputEl;
                inputEl.addEventListener('input', () => {
                    this.showSuggestions(inputEl, inputEl.value, 'file');
                });
                inputEl.addEventListener('blur', () => {
                    this.debouncedSave(`source-${link.id}`, async () => {
                        link.sourceNotePath = inputEl.value;
                        await this.plugin.saveSettings();
                        await this.plugin.restartServices();
                    });
                });
            });

        // Source sections
        new Setting(containerEl)
            .setName('Source sections')
            .setDesc('Section headers to pull from (comma-separated, empty = all)')
            .addText(text => text
                .setPlaceholder('## Tasks, ## Homework')
                .setValue(link.sourceSections.join(', '))
                .onChange((value) => {
                    this.debouncedSave(`sections-${link.id}`, async () => {
                        link.sourceSections = value
                            ? value.split(',').map(s => s.trim()).filter(s => s)
                            : [];
                        await this.plugin.saveSettings();
                    });
                }));

        // Exclude emoji
        new Setting(containerEl)
            .setName('Exclude emoji')
            .setDesc('Tasks containing this emoji will be skipped')
            .addText(text => text
                .setPlaceholder('🚫')
                .setValue(link.excludeEmoji)
                .onChange(async (value) => {
                    link.excludeEmoji = value;
                    await this.plugin.saveSettings();
                }));

        // Include completed
        new Setting(containerEl)
            .setName('Include completed tasks')
            .setDesc('Whether to sync tasks that are already checked')
            .addToggle(toggle => toggle
                .setValue(link.includeCompleted)
                .onChange(async (value) => {
                    link.includeCompleted = value;
                    await this.plugin.saveSettings();
                }));

        // Filter tags
        new Setting(containerEl)
            .setName('Filter tags')
            .setDesc('Only sync tasks with these tags (comma-separated, empty = no filter)')
            .addText(text => text
                .setPlaceholder('#homework, #urgent')
                .setValue(link.filterTags.join(', '))
                .onChange((value) => {
                    this.debouncedSave(`tags-${link.id}`, async () => {
                        link.filterTags = value
                            ? value.split(',').map(s => s.trim()).filter(s => s)
                            : [];
                        await this.plugin.saveSettings();
                    });
                }));
    }

    private debouncedSave(key: string, fn: () => Promise<void>): void {
        const existing = this.debounceTimers.get(key);
        if (existing) clearTimeout(existing);
        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            fn();
        }, 300));
    }

    private renderExclusionList(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        list: string[],
        type: 'folder' | 'file'
    ): void {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desc);

        setting.addButton(button => button
            .setButtonText('Add')
            .onClick(async () => {
                list.push('');
                await this.plugin.saveSettings();
                this.display();
            }));

        for (let i = 0; i < list.length; i++) {
            const itemSetting = new Setting(containerEl)
                .setClass('task-sync-exclusion-item');

            itemSetting.addSearch(search => {
                search
                    .setPlaceholder(type === 'folder' ? 'Folder path...' : 'File path...')
                    .setValue(list[i]);

                const inputEl = search.inputEl;
                inputEl.addEventListener('input', () => {
                    this.showSuggestions(inputEl, inputEl.value, type);
                });
                inputEl.addEventListener('blur', async () => {
                    setTimeout(async () => {
                        list[i] = inputEl.value;
                        await this.plugin.saveSettings();
                    }, 200);
                });
            });

            itemSetting.addButton(button => button
                .setButtonText('Remove')
                .setWarning()
                .onClick(async () => {
                    list.splice(i, 1);
                    await this.plugin.saveSettings();
                    this.display();
                }));
        }
    }

    private showSuggestions(inputEl: HTMLInputElement, query: string, type: 'folder' | 'file'): void {
        const existingSuggestions = document.querySelector('.task-sync-suggestions');
        if (existingSuggestions) {
            existingSuggestions.remove();
        }

        if (!query) return;

        const suggestions: string[] = [];
        const lowerQuery = query.toLowerCase();

        if (type === 'folder') {
            const folders = this.app.vault.getAllLoadedFiles()
                .filter(f => f instanceof TFolder)
                .map(f => f.path)
                .filter(p => p.toLowerCase().includes(lowerQuery))
                .slice(0, 10);
            suggestions.push(...folders);
        } else {
            const files = this.app.vault.getMarkdownFiles()
                .map(f => f.path)
                .filter(p => p.toLowerCase().includes(lowerQuery))
                .slice(0, 10);
            suggestions.push(...files);
        }

        if (suggestions.length === 0) return;

        const suggestionsEl = document.createElement('div');
        suggestionsEl.className = 'task-sync-suggestions';
        suggestionsEl.style.cssText = 'position:absolute;background:var(--background-primary);border:1px solid var(--background-modifier-border);border-radius:4px;max-height:200px;overflow-y:auto;z-index:1000;';

        for (const suggestion of suggestions) {
            const item = document.createElement('div');
            item.textContent = suggestion;
            item.style.cssText = 'padding:4px 8px;cursor:pointer;';
            item.addEventListener('mouseenter', () => {
                item.style.background = 'var(--background-modifier-hover)';
            });
            item.addEventListener('mouseleave', () => {
                item.style.background = '';
            });
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                inputEl.value = suggestion;
                suggestionsEl.remove();
            });
            suggestionsEl.appendChild(item);
        }

        const rect = inputEl.getBoundingClientRect();
        suggestionsEl.style.top = `${rect.bottom}px`;
        suggestionsEl.style.left = `${rect.left}px`;
        suggestionsEl.style.width = `${rect.width}px`;
        document.body.appendChild(suggestionsEl);

        const removeHandler = (e: MouseEvent) => {
            if (!suggestionsEl.contains(e.target as Node)) {
                suggestionsEl.remove();
                document.removeEventListener('click', removeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', removeHandler), 0);
    }

    private renderFileNameExclusionList(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        list: string[]
    ): void {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desc);

        setting.addButton(button => button
            .setButtonText('Add')
            .onClick(async () => {
                list.push('');
                await this.plugin.saveSettings();
                this.display();
            }));

        for (let i = 0; i < list.length; i++) {
            const itemSetting = new Setting(containerEl)
                .setClass('task-sync-exclusion-item');

            itemSetting.addText(text => {
                text
                    .setPlaceholder('File name (e.g., Session Log.md)')
                    .setValue(list[i])
                    .onChange(async (value) => {
                        list[i] = value;
                        await this.plugin.saveSettings();
                    });
            });

            itemSetting.addButton(button => button
                .setButtonText('Remove')
                .setWarning()
                .onClick(async () => {
                    list.splice(i, 1);
                    await this.plugin.saveSettings();
                    this.display();
                }));
        }
    }
}
