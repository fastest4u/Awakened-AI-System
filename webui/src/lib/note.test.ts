import { describe, it, expect } from 'vitest';
import { extractNoteBodyText, deriveHumanTitle } from './note';

describe('extractNoteBodyText', () => {
  it('extracts body from { format: "markdown", body: "# T" }', () => {
    expect(extractNoteBodyText({ format: 'markdown', body: '# T' })).toBe('# T');
  });

  it('extracts body from { content: { body: "x" } }', () => {
    expect(extractNoteBodyText({ content: { body: 'x' } })).toBe('x');
  });

  it('handles raw strings', () => {
    expect(extractNoteBodyText('Hello world')).toBe('Hello world');
  });

  it('handles { content: "direct string" }', () => {
    expect(extractNoteBodyText({ content: 'direct string' })).toBe('direct string');
  });

  it('returns empty string for non-string types and unexpected shapes', () => {
    expect(extractNoteBodyText(42)).toBe('');
    expect(extractNoteBodyText(null)).toBe('');
    expect(extractNoteBodyText(undefined)).toBe('');
    expect(extractNoteBodyText({})).toBe('');
    expect(extractNoteBodyText({ random: 123 })).toBe('');
    expect(extractNoteBodyText({ body: { nested: 'object' } })).toBe('');
  });
});

describe('deriveHumanTitle', () => {
  it('returns explicit title when present', () => {
    expect(
      deriveHumanTitle({
        title: 'Explicit Title',
        summary: 'Summary text',
        recordId: 'rec-1',
      }),
    ).toBe('Explicit Title');
  });

  it('extracts non-generic H1 from note body', () => {
    expect(
      deriveHumanTitle({
        title: '',
        summary: 'Summary text',
        recordId: 'rec-2',
        body: '# Custom Architectural Pattern\n\nDetails...',
      }),
    ).toBe('Custom Architectural Pattern');
  });

  it('skips generic headings and falls back to clean summary line', () => {
    const genericHeadings = [
      '# Problem',
      '# Context',
      '# Summary',
      '# Background',
      '# Overview',
      '# ปัญหา',
      '# บริบท',
    ];

    for (const heading of genericHeadings) {
      expect(
        deriveHumanTitle({
          title: '',
          summary: 'ADR: Use React 19 for Client SPA\nSecond line',
          recordId: 'rec-3',
          body: `${heading}\n\nSome body text`,
        }),
      ).toBe('Use React 19 for Client SPA');
    }
  });

  it('falls back to recordId when title, body, and summary are missing', () => {
    expect(
      deriveHumanTitle({
        title: '',
        summary: '',
        recordId: 'rec-fallback-99',
      }),
    ).toBe('rec-fallback-99');
  });
});
