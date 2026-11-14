/**
 * Pure helper functions for the Kanban board and table view.
 * Layering rule: webui/src/lib/ must NOT import React.
 */

export type KanbanColumnId = 'candidates' | 'verified' | 'archived';

/**
 * Maps a note status to one of the 3 Kanban columns or null if not displayed.
 * - candidates: 'candidate', 'provisional'
 * - verified: 'verified', 'active'
 * - archived: 'superseded', 'conflicted', 'expired'
 * - other (e.g. 'retracted', unknown): null
 */
export function columnForStatus(status: string): KanbanColumnId | null {
  const s = (status || '').toLowerCase().trim();
  if (s === 'candidate' || s === 'provisional') {
    return 'candidates';
  }
  if (s === 'verified' || s === 'active') {
    return 'verified';
  }
  if (s === 'superseded' || s === 'conflicted' || s === 'expired') {
    return 'archived';
  }
  return null;
}

export interface CapNoteBadgesInput {
  filePaths?: string[] | null;
  symbols?: string[] | null;
}

export interface CapNoteBadgesResult {
  files: string[];
  symbols: string[];
  hidden: number;
}

/**
 * Caps filePaths at ≤3 items, symbols at ≤4 items, and computes the hidden count
 * of remaining items.
 */
export function capNoteBadges(n: CapNoteBadgesInput): CapNoteBadgesResult {
  const allFiles = Array.isArray(n.filePaths) ? n.filePaths : [];
  const allSymbols = Array.isArray(n.symbols) ? n.symbols : [];

  const files = allFiles.slice(0, 3);
  const symbols = allSymbols.slice(0, 4);

  const hidden =
    Math.max(0, allFiles.length - files.length) +
    Math.max(0, allSymbols.length - symbols.length);

  return {
    files,
    symbols,
    hidden,
  };
}
