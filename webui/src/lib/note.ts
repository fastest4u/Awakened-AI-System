import type { NoteItem } from '@/api/types';

/**
 * Extracts note body text safely from various note representations.
 * Handles strings, { format: 'markdown', body }, { content: { body } },
 * { content: string }, and avoids returning [object Object] or unexpected non-string types.
 */
export function extractNoteBodyText(body: unknown): string {
  if (typeof body === 'string') {
    return body;
  }

  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;

    if (typeof obj.body === 'string') {
      return obj.body;
    }

    if (typeof obj.content === 'string') {
      return obj.content;
    }

    if (
      obj.content &&
      typeof obj.content === 'object' &&
      typeof (obj.content as Record<string, unknown>).body === 'string'
    ) {
      return (obj.content as Record<string, unknown>).body as string;
    }

    if (typeof obj.text === 'string') {
      return obj.text;
    }
  }

  return '';
}

const GENERIC_HEADING_REGEX =
  /^(?:context|summary|problem|root causes?(?:\s*&\s*(?:fix|prevention))?|fix|prevention|overview|background|ปัญหา|บริบท)$/i;

/**
 * Derives a human-friendly title for a note, avoiding generic headings like
 * Problem, Context, Summary, Background, Overview, ปัญหา, บริบท.
 */
export function deriveHumanTitle(
  note: Pick<NoteItem, 'title' | 'summary' | 'recordId'> & {
    body?: unknown;
    text?: string;
    content?: unknown;
  },
): string {
  if (note.title && typeof note.title === 'string' && note.title.trim()) {
    return note.title.trim();
  }

  const rawBody = extractNoteBodyText(note.body ?? (note as any).content);
  if (rawBody) {
    const headingMatch = /^\s*#\s+(.+)$/m.exec(rawBody);
    if (headingMatch) {
      const rawH1 = headingMatch[1].trim();
      if (rawH1 && !GENERIC_HEADING_REGEX.test(rawH1)) {
        return rawH1;
      }
    }
  }

  const summarySource = note.summary || note.text || '';
  if (summarySource) {
    const summaryLine = String(summarySource)
      .split('\n')[0]
      .replace(/^(?:ADR|Insight|Mistake):\s*/i, '')
      .trim()
      .slice(0, 90);
    if (summaryLine) {
      return summaryLine;
    }
  }

  return note.recordId || '';
}
