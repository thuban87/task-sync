/**
 * Base interface for all TaskLink connections.
 */
export interface TaskLinkBase {
    id: string;
    type: 'priority-scan' | 'note-mirror';
    enabled: boolean;
    sectionHeader: string;
    taskLimit: number;
    collapsible: boolean;
    calloutType: string;
    enableBidirectionalSync: boolean;
}

export interface PriorityScanLink extends TaskLinkBase {
    type: 'priority-scan';
    includeHighest: boolean;
    includeHigh: boolean;
    excludedFolders: string[];
    excludedFiles: string[];
    excludedFileNames: string[];
}

export interface NoteMirrorLink extends TaskLinkBase {
    type: 'note-mirror';
    sourceNotePath: string;
    sourceSections: string[];
    excludeEmoji: string;
    includeCompleted: boolean;
    filterTags: string[];
}

export type TaskLink = PriorityScanLink | NoteMirrorLink;

/**
 * Generate a unique ID for a TaskLink.
 */
export function generateId(): string {
    return Math.random().toString(36).substring(2, 10) + Date.now().toString(36);
}

export const DEFAULT_PRIORITY_SCAN_LINK: PriorityScanLink = {
    id: 'priority-scan-default',
    type: 'priority-scan',
    enabled: true,
    sectionHeader: '## ⚡ High Priority Tasks',
    taskLimit: 5,
    collapsible: false,
    calloutType: 'todo',
    enableBidirectionalSync: true,
    includeHighest: true,
    includeHigh: true,
    excludedFolders: [],
    excludedFiles: [],
    excludedFileNames: [],
};

export const DEFAULT_NOTE_MIRROR_LINK: NoteMirrorLink = {
    id: '',
    type: 'note-mirror',
    enabled: true,
    sectionHeader: '',
    taskLimit: 0,
    collapsible: false,
    calloutType: 'todo',
    enableBidirectionalSync: true,
    sourceNotePath: '',
    sourceSections: [],
    excludeEmoji: '',
    includeCompleted: false,
    filterTags: [],
};
