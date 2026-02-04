/**
 * Priority emoji markers (Tasks plugin format)
 */
export const PRIORITY_MARKERS = {
    highest: '⏫',
    high: '🔺',
} as const;

/**
 * Regex to match priority markers
 */
export const PRIORITY_REGEX = /[⏫🔺]/;

/**
 * Regex to match markdown checkbox (captures indent, checkbox state)
 * Group 1: leading whitespace
 * Group 2: checkbox state (space, x, or X)
 */
export const CHECKBOX_REGEX = /^(\s*)-\s*\[([ xX])\]/;

/**
 * Regex to match wikilink (captures link target)
 * Group 1: link target (without brackets)
 */
export const WIKILINK_REGEX = /\[\[([^\]]+)\]\]/;

/**
 * Regex to match uncompleted checkbox
 */
export const UNCOMPLETED_CHECKBOX_REGEX = /^(\s*)-\s*\[ \]/;

/**
 * Regex to match completed checkbox
 */
export const COMPLETED_CHECKBOX_REGEX = /^(\s*)-\s*\[[xX]\]/;
