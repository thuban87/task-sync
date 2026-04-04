/**
 * A task that can be synced to the daily note.
 * Used by both priority-scan and note-mirror connections.
 */
export interface SyncableTask {
    /** The full raw text of the task line found in the source */
    originalLine: string;

    /**
     * Display/matching text.
     * - Priority-scan: aggressively cleaned (stripped of checkboxes, priority markers, wikilinks, metadata).
     * - Note-mirror: lightly cleaned (checkbox prefix stripped only). Preserves tags, dates, and other content.
     */
    displayText: string;

    /** Path to source file (relative to vault root) */
    filePath: string;

    /** Line number in source file (0-indexed) */
    lineNumber: number;

    /** Priority level. Present for priority-scan tasks, absent for note-mirror tasks. */
    priority?: 'highest' | 'high';

    /** ID of the TaskLink connection that produced this task */
    linkId: string;

    /** Leading whitespace (indentation) from the original line */
    indent?: string;
}

/**
 * Represents a task already synced to the daily note.
 */
export interface SyncedTask {
    /** Display text (for deduplication matching) */
    displayText: string;

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

    /** Display text for matching to source */
    displayText: string;

    /** Source file path extracted from wikilink */
    sourcePath: string | null;
}
