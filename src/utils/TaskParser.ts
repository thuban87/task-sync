import { App, TFile } from 'obsidian';
import {
    PRIORITY_MARKERS,
    CHECKBOX_REGEX,
    UNCOMPLETED_CHECKBOX_REGEX,
    COMPLETED_CHECKBOX_REGEX,
} from '../constants';

/**
 * Represents the state of a task for matching/reconciliation.
 */
export interface TaskState {
    /** Line number in file (0-indexed) */
    lineNumber: number;
    /** Clean text for matching */
    cleanText: string;
    /** Priority level */
    priority: 'highest' | 'high' | null;
    /** Whether checkbox is checked */
    checked: boolean;
    /** Source file path (from wikilink, if present) */
    sourcePath: string | null;
    /** Original full line text */
    originalLine: string;
}

/**
 * Result of matching old and new task states.
 */
export interface TaskMatch {
    /** The new task state */
    newState: TaskState;
    /** The old task state that matched (null if new task) */
    oldState: TaskState | null;
    /** Whether the checked state changed */
    checkedChanged: boolean;
}

/**
 * Shared task parsing utilities.
 * Centralizes all task text cleaning, priority extraction, and matching logic.
 */
export class TaskParser {
    /**
     * Clean task text for deduplication/matching.
     * Strips: checkbox, priority emoji, wikilinks, markdown links, Tasks plugin metadata.
     */
    static cleanTaskText(line: string): string {
        let cleaned = line;

        // Remove checkbox prefix (- [ ] or - [x])
        cleaned = cleaned.replace(/^\s*-\s*\[[ xX]\]\s*/, '');

        // Remove priority emojis (⏫ 🔺 🔼 🔽 ⏬)
        cleaned = cleaned.replace(/[⏫🔺🔼🔽⏬]/g, '');

        // Remove Tasks plugin metadata:
        // ✅ Done date, 📅 Due date, ⏳ Scheduled, 🛫 Start, 🔁 Recurrence, ➕ Created
        cleaned = cleaned.replace(/[✅📅⏳🛫🔁➕]\s*\d{4}-\d{2}-\d{2}/g, '');

        // Remove standalone completion emoji (sometimes without date)
        cleaned = cleaned.replace(/✅/g, '');

        // Remove wikilinks entirely (these are source file refs we add)
        cleaned = cleaned.replace(/\[\[[^\]]+\]\]/g, '');

        // Remove markdown links entirely [text](url)
        cleaned = cleaned.replace(/\[[^\]]+\]\([^)]+\)/g, '');

        // Normalize whitespace
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        return cleaned;
    }

    /**
     * Extract priority level from task line.
     * @returns 'highest' (⏫), 'high' (🔺), or null
     */
    static extractPriority(line: string): 'highest' | 'high' | null {
        if (line.includes(PRIORITY_MARKERS.highest)) {
            return 'highest';
        }
        if (line.includes(PRIORITY_MARKERS.high)) {
            return 'high';
        }
        return null;
    }

    /**
     * Extract source file path from wikilink in line.
     * e.g., "[[Work/Reports]]" → "Work/Reports.md"
     * 
     * @param line - The task line containing a wikilink
     * @param app - Optional Obsidian App for resolving links
     * @returns Full file path or null if no wikilink found
     */
    static extractSourcePath(line: string, app?: App): string | null {
        // Use non-global regex to avoid lastIndex issues
        const wikilinkRegex = /\[\[([^\]|]+)(?:\|[^\]]*)?]\]/;
        const match = line.match(wikilinkRegex);

        if (!match) {
            return null;
        }

        let linkTarget = match[1];

        // Add .md extension if not present
        if (!linkTarget.endsWith('.md')) {
            linkTarget += '.md';
        }

        // If app is provided, resolve to actual file path
        if (app) {
            const file = app.metadataCache.getFirstLinkpathDest(match[1], '');
            if (file) {
                return file.path;
            }
        }

        return linkTarget;
    }

    /**
     * Check if task line is uncompleted (- [ ]).
     */
    static isUncompleted(line: string): boolean {
        return UNCOMPLETED_CHECKBOX_REGEX.test(line);
    }

    /**
     * Check if task line is completed (- [x] or - [X]).
     */
    static isCompleted(line: string): boolean {
        return COMPLETED_CHECKBOX_REGEX.test(line);
    }

    /**
     * Check if line is any checkbox (completed or not).
     */
    static isCheckbox(line: string): boolean {
        return CHECKBOX_REGEX.test(line);
    }

    /**
     * Parse a single line into TaskState.
     * 
     * @param line - The line text
     * @param lineNumber - Line number (0-indexed)
     * @param app - Optional Obsidian App for resolving links
     */
    static parseTaskState(line: string, lineNumber: number, app?: App): TaskState | null {
        if (!this.isCheckbox(line)) {
            return null;
        }

        const checkboxMatch = line.match(CHECKBOX_REGEX);
        const checked = checkboxMatch ? checkboxMatch[2].toLowerCase() === 'x' : false;

        return {
            lineNumber,
            cleanText: this.cleanTaskText(line),
            priority: this.extractPriority(line),
            checked,
            sourcePath: this.extractSourcePath(line, app),
            originalLine: line,
        };
    }

    /**
     * Parse all task states from file content.
     * 
     * @param content - Full file content
     * @param app - Optional Obsidian App for resolving links
     * @returns Map of lineNumber → TaskState
     */
    static parseAllTaskStates(content: string, app?: App): Map<number, TaskState> {
        const states = new Map<number, TaskState>();
        const lines = content.split('\n');

        for (let i = 0; i < lines.length; i++) {
            const state = this.parseTaskState(lines[i], i, app);
            if (state) {
                states.set(i, state);
            }
        }

        return states;
    }

    /**
     * Match tasks between old and new states using multiple signals.
     * Uses cleanText (strong), priority (supporting), and lineNumber (weak) for matching.
     * 
     * @param oldStates - Previous task states (by line number)
     * @param newStates - Current task states (by line number)
     * @returns Array of matches with change detection
     */
    static matchTasks(
        oldStates: Map<number, TaskState>,
        newStates: Map<number, TaskState>
    ): TaskMatch[] {
        const matches: TaskMatch[] = [];
        const matchedOldKeys = new Set<number>();

        for (const [newLineNum, newState] of newStates) {
            let bestMatch: { oldState: TaskState; score: number } | null = null;

            for (const [oldLineNum, oldState] of oldStates) {
                if (matchedOldKeys.has(oldLineNum)) continue;

                let score = 0;

                // Strong signal: cleanText matches
                if (oldState.cleanText === newState.cleanText) {
                    score += 3;
                }

                // Supporting signal: priority matches
                if (oldState.priority === newState.priority) {
                    score += 1;
                }

                // Weak signal: same line number
                if (oldLineNum === newLineNum) {
                    score += 1;
                }

                // Need at least 2 signals to consider it a match
                if (score >= 2 && (!bestMatch || score > bestMatch.score)) {
                    bestMatch = { oldState, score };
                }
            }

            if (bestMatch) {
                matchedOldKeys.add(bestMatch.oldState.lineNumber);
                matches.push({
                    newState,
                    oldState: bestMatch.oldState,
                    checkedChanged: bestMatch.oldState.checked !== newState.checked,
                });
            } else {
                // New task (no match found)
                matches.push({
                    newState,
                    oldState: null,
                    checkedChanged: false,
                });
            }
        }

        return matches;
    }

    /**
     * Find tasks that changed their checked state.
     * Convenience wrapper around matchTasks for sync services.
     */
    static findChangedTasks(
        oldStates: Map<number, TaskState>,
        newStates: Map<number, TaskState>
    ): { state: TaskState; nowChecked: boolean }[] {
        const matches = this.matchTasks(oldStates, newStates);

        return matches
            .filter(m => m.checkedChanged && m.oldState !== null)
            .map(m => ({
                state: m.newState,
                nowChecked: m.newState.checked,
            }));
    }
}
