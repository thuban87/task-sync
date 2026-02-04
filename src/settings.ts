import { App, PluginSettingTab, Setting, TFolder } from 'obsidian';
import type TaskSyncPlugin from '../main';

/**
 * Plugin settings interface.
 */
export interface PluginSettings {
    /** Enable/disable the sync feature */
    enabled: boolean;

    /** Section header to target in daily note */
    sectionHeader: string;

    /** Maximum tasks to sync (0 = unlimited) */
    taskLimit: number;

    /** Debounce delay in milliseconds */
    debounceMs: number;

    /** Include 'highest' priority (⏫) tasks */
    includeHighest: boolean;

    /** Include 'high' priority (🔺) tasks */
    includeHigh: boolean;

    /** Enable two-way sync (daily note → source) */
    enableReverseSync: boolean;

    /** Folders to exclude from scanning */
    excludedFolders: string[];

    /** Files to exclude from scanning (full path) */
    excludedFiles: string[];

    /** File names to exclude from scanning (matches any directory) */
    excludedFileNames: string[];
}

/**
 * Default settings values.
 */
export const DEFAULT_SETTINGS: PluginSettings = {
    enabled: true,
    sectionHeader: '## ⚡ High Priority Tasks',
    taskLimit: 5,
    debounceMs: 3500,
    includeHighest: true,
    includeHigh: true,
    enableReverseSync: true,
    excludedFolders: [],
    excludedFiles: [],
    excludedFileNames: [],
};

/**
 * Settings tab UI.
 */
export class TaskSyncSettingTab extends PluginSettingTab {
    plugin: TaskSyncPlugin;

    constructor(app: App, plugin: TaskSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Task Sync Settings' });

        // Master toggle
        new Setting(containerEl)
            .setName('Enable sync')
            .setDesc('Turn task syncing on or off')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enabled)
                .onChange(async (value) => {
                    this.plugin.settings.enabled = value;
                    await this.plugin.saveSettings();
                    if (value) {
                        this.plugin.startServices();
                    } else {
                        this.plugin.stopServices();
                    }
                }));

        // Section header
        new Setting(containerEl)
            .setName('Section header')
            .setDesc('The header in your daily note where tasks will be synced')
            .addText(text => text
                .setPlaceholder('## ⚡ High Priority Tasks')
                .setValue(this.plugin.settings.sectionHeader)
                .onChange(async (value) => {
                    this.plugin.settings.sectionHeader = value;
                    await this.plugin.saveSettings();
                }));

        // Task limit
        new Setting(containerEl)
            .setName('Task limit')
            .setDesc('Maximum number of tasks to sync (0 = no limit)')
            .addText(text => text
                .setPlaceholder('5')
                .setValue(String(this.plugin.settings.taskLimit))
                .onChange(async (value) => {
                    const num = parseInt(value, 10);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.taskLimit = num;
                        await this.plugin.saveSettings();
                    }
                }));

        // Debounce delay
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

        containerEl.createEl('h3', { text: 'Priority Filters' });

        // Include highest priority
        new Setting(containerEl)
            .setName('Include highest priority (⏫)')
            .setDesc('Sync tasks marked with the highest priority emoji')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeHighest)
                .onChange(async (value) => {
                    this.plugin.settings.includeHighest = value;
                    await this.plugin.saveSettings();
                }));

        // Include high priority
        new Setting(containerEl)
            .setName('Include high priority (🔺)')
            .setDesc('Sync tasks marked with the high priority emoji')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.includeHigh)
                .onChange(async (value) => {
                    this.plugin.settings.includeHigh = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Two-Way Sync' });

        // Enable reverse sync
        new Setting(containerEl)
            .setName('Enable reverse sync')
            .setDesc('When you check a task in your daily note, also check it in the source file')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableReverseSync)
                .onChange(async (value) => {
                    this.plugin.settings.enableReverseSync = value;
                    await this.plugin.saveSettings();
                }));

        containerEl.createEl('h3', { text: 'Exclusions' });

        // Excluded folders
        this.renderExclusionList(
            containerEl,
            'Excluded folders',
            'Folders to ignore when scanning for tasks',
            this.plugin.settings.excludedFolders,
            'folder'
        );

        // Excluded files
        this.renderExclusionList(
            containerEl,
            'Excluded files',
            'Files to ignore when scanning for tasks (full path)',
            this.plugin.settings.excludedFiles,
            'file'
        );

        // Excluded file names
        this.renderFileNameExclusionList(
            containerEl,
            'Excluded file names',
            'File names to ignore in ANY directory (e.g., "Session Log.md")',
            this.plugin.settings.excludedFileNames
        );
    }

    /**
     * Render an exclusion list with add/remove functionality.
     */
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

        // Add button
        setting.addButton(button => button
            .setButtonText('Add')
            .onClick(async () => {
                list.push('');
                await this.plugin.saveSettings();
                this.display(); // Refresh UI
            }));

        // Render existing items
        for (let i = 0; i < list.length; i++) {
            const itemSetting = new Setting(containerEl)
                .setClass('task-sync-exclusion-item');

            itemSetting.addSearch(search => {
                search
                    .setPlaceholder(type === 'folder' ? 'Folder path...' : 'File path...')
                    .setValue(list[i]);

                // Add autocomplete suggestions
                const inputEl = search.inputEl;
                inputEl.addEventListener('input', () => {
                    const value = inputEl.value;
                    this.showSuggestions(inputEl, value, type);
                });

                inputEl.addEventListener('blur', async () => {
                    // Save on blur
                    setTimeout(async () => {
                        list[i] = inputEl.value;
                        await this.plugin.saveSettings();
                    }, 200);
                });
            });

            // Remove button
            itemSetting.addButton(button => button
                .setButtonText('Remove')
                .setWarning()
                .onClick(async () => {
                    list.splice(i, 1);
                    await this.plugin.saveSettings();
                    this.display(); // Refresh UI
                }));
        }
    }

    /**
     * Show autocomplete suggestions for path input.
     */
    private showSuggestions(inputEl: HTMLInputElement, query: string, type: 'folder' | 'file'): void {
        // Remove existing suggestions
        const existingSuggestions = document.querySelector('.task-sync-suggestions');
        if (existingSuggestions) {
            existingSuggestions.remove();
        }

        if (!query) return;

        const suggestions: string[] = [];
        const lowerQuery = query.toLowerCase();

        if (type === 'folder') {
            // Get all folders
            const folders = this.app.vault.getAllLoadedFiles()
                .filter(f => f instanceof TFolder) // Is a folder
                .map(f => f.path)
                .filter(p => p.toLowerCase().includes(lowerQuery))
                .slice(0, 10);
            suggestions.push(...folders);
        } else {
            // Get all markdown files
            const files = this.app.vault.getMarkdownFiles()
                .map(f => f.path)
                .filter(p => p.toLowerCase().includes(lowerQuery))
                .slice(0, 10);
            suggestions.push(...files);
        }

        if (suggestions.length === 0) return;

        // Create suggestions dropdown
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

        // Position below input
        const rect = inputEl.getBoundingClientRect();
        suggestionsEl.style.top = `${rect.bottom}px`;
        suggestionsEl.style.left = `${rect.left}px`;
        suggestionsEl.style.width = `${rect.width}px`;
        document.body.appendChild(suggestionsEl);

        // Remove on click outside
        const removeHandler = (e: MouseEvent) => {
            if (!suggestionsEl.contains(e.target as Node)) {
                suggestionsEl.remove();
                document.removeEventListener('click', removeHandler);
            }
        };
        setTimeout(() => document.addEventListener('click', removeHandler), 0);
    }

    /**
     * Render a simple text-based exclusion list for file names.
     */
    private renderFileNameExclusionList(
        containerEl: HTMLElement,
        name: string,
        desc: string,
        list: string[]
    ): void {
        const setting = new Setting(containerEl)
            .setName(name)
            .setDesc(desc);

        // Add button
        setting.addButton(button => button
            .setButtonText('Add')
            .onClick(async () => {
                list.push('');
                await this.plugin.saveSettings();
                this.display(); // Refresh UI
            }));

        // Render existing items
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

            // Remove button
            itemSetting.addButton(button => button
                .setButtonText('Remove')
                .setWarning()
                .onClick(async () => {
                    list.splice(i, 1);
                    await this.plugin.saveSettings();
                    this.display(); // Refresh UI
                }));
        }
    }
}
