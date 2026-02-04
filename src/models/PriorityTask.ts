/**
 * Represents a high-priority task found in the vault.
 */
export interface PriorityTask {
    /** The full raw text of the task line found in the source */
    originalLine: string;

    /**
     * The "clean" text used for deduplication.
     * Stripped of checkboxes (- [ ]), priority markers (🔺/⏫), and wikilinks.
     */
    cleanText: string;

    /** Path to source file (relative to vault root) */
    filePath: string;

    /** Line number in source file (0-indexed) */
    lineNumber: number;

    /** Priority level */
    priority: 'highest' | 'high';
}

/**
 * Represents a task already synced to the daily note.
 */
export interface SyncedTask {
    /** Clean text (for deduplication matching) */
    cleanText: string;

    /** The full line as it currently exists in the Daily Note */
    line: string;

    /** Whether the checkbox is checked */
    completed: boolean;

    /** Line number in daily note */
    lineNumber: number;
}

/**
 * Tracks checkbox state for reverse sync detection.
 */
export interface CheckboxState {
    /** Line number in daily note */
    lineNumber: number;

    /** Whether checkbox is checked */
    checked: boolean;

    /** Clean text for matching to source */
    cleanText: string;

    /** Source file path extracted from wikilink */
    sourcePath: string | null;
}
