import { describe, it, expect } from 'vitest';
import { columnForStatus, capNoteBadges } from './kanban';

describe('kanban pure helpers', () => {
  describe('columnForStatus', () => {
    it('maps candidate and provisional to candidates', () => {
      expect(columnForStatus('provisional')).toBe('candidates');
      expect(columnForStatus('candidate')).toBe('candidates');
    });

    it('maps active and verified to verified', () => {
      expect(columnForStatus('active')).toBe('verified');
      expect(columnForStatus('verified')).toBe('verified');
    });

    it('maps superseded, conflicted, and expired to archived', () => {
      expect(columnForStatus('superseded')).toBe('archived');
      expect(columnForStatus('conflicted')).toBe('archived');
      expect(columnForStatus('expired')).toBe('archived');
    });

    it('returns null for retracted or unknown statuses', () => {
      expect(columnForStatus('retracted')).toBeNull();
      expect(columnForStatus('unknown')).toBeNull();
      expect(columnForStatus('')).toBeNull();
    });
  });

  describe('capNoteBadges', () => {
    it('caps filePaths at 3, symbols at 4, and computes hidden remaining count', () => {
      const filePaths = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'];
      const symbols = ['s1', 's2', 's3', 's4', 's5', 's6'];
      const result = capNoteBadges({ filePaths, symbols });

      expect(result.files).toEqual(['f1.ts', 'f2.ts', 'f3.ts']);
      expect(result.symbols).toEqual(['s1', 's2', 's3', 's4']);
      expect(result.hidden).toBe(4);
    });

    it('handles counts under the limit with 0 hidden', () => {
      const filePaths = ['f1.ts', 'f2.ts'];
      const symbols = ['s1', 's2', 's3'];
      const result = capNoteBadges({ filePaths, symbols });

      expect(result.files).toEqual(['f1.ts', 'f2.ts']);
      expect(result.symbols).toEqual(['s1', 's2', 's3']);
      expect(result.hidden).toBe(0);
    });

    it('handles empty or missing arrays safely', () => {
      const result = capNoteBadges({ filePaths: [], symbols: [] });
      expect(result.files).toEqual([]);
      expect(result.symbols).toEqual([]);
      expect(result.hidden).toBe(0);
    });
  });
});
