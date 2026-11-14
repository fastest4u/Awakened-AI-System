import { describe, it, expect } from 'vitest';
import {
  humanKindLabel,
  shortNodeDisplayLabel,
  fullNodeTooltipLabel,
} from './graph-labels';
import type { GraphNode } from '@/api/types';

describe('graph-labels', () => {
  describe('humanKindLabel', () => {
    it('returns correct Thai descriptions for various node kinds and subkinds', () => {
      expect(humanKindLabel(null)).toBe('');
      expect(
        humanKindLabel({ id: 's1', label: 's1', kind: 'session' } as GraphNode),
      ).toBe('เซสชันการทำงานของ AI (AI Session)');
      expect(
        humanKindLabel({ id: 'f1', label: 'f1', kind: 'file' } as GraphNode),
      ).toBe('ไฟล์ซอร์สโค้ด (Project File)');
      expect(
        humanKindLabel({ id: 'sym1', label: 'sym1', kind: 'symbol' } as GraphNode),
      ).toBe('ฟังก์ชัน / คลาส (Code Symbol)');
      expect(
        humanKindLabel({
          id: 'n1',
          label: 'n1',
          kind: 'note',
          subkind: 'adr',
        } as GraphNode),
      ).toBe('การตัดสินใจสถาปัตยกรรม (ADR)');
      expect(
        humanKindLabel({
          id: 'n2',
          label: 'n2',
          kind: 'note',
          subkind: 'mistake',
        } as GraphNode),
      ).toBe('ข้อผิดพลาดที่แก้ไขแล้ว (Mistake)');
      expect(
        humanKindLabel({
          id: 'n3',
          label: 'n3',
          kind: 'note',
          subkind: 'session-log',
        } as GraphNode),
      ).toBe('บันทึกสรุปเซสชัน (Session Log)');
      expect(
        humanKindLabel({
          id: 'n4',
          label: 'n4',
          kind: 'note',
          subkind: 'insight',
        } as GraphNode),
      ).toBe('บทเรียนและเทคนิคสำคัญ (Insight)');
    });
  });

  describe('shortNodeDisplayLabel', () => {
    it('extracts file basename and truncates labels longer than 30 chars', () => {
      const fileNode: GraphNode = {
        id: 'file:src/v2/webui/views-and-web-components.ts',
        label: 'src/v2/webui/views-and-web-components.ts',
        kind: 'file',
      };
      expect(shortNodeDisplayLabel(fileNode)).toBe(
        'views-and-web-components.ts',
      );

      const winFileNode: GraphNode = {
        id: 'file:src\\controllers\\graph-view.ts',
        label: 'src\\controllers\\graph-view.ts',
        kind: 'file',
      };
      expect(shortNodeDisplayLabel(winFileNode)).toBe('graph-view.ts');

      const longLabelNode: GraphNode = {
        id: 'note:1',
        label: 'This is an extremely long title that exceeds thirty characters by far',
        kind: 'note',
      };
      const short = shortNodeDisplayLabel(longLabelNode);
      expect(short.length).toBeLessThanOrEqual(30);
      expect(short.endsWith('…')).toBe(true);

      const sessionWithTask: GraphNode = {
        id: 'session:s1',
        label: 's1',
        kind: 'session',
        sessionId: 's10001',
        currentTask: 'ADR: Refactor storage adapter',
      };
      expect(shortNodeDisplayLabel(sessionWithTask)).toBe(
        'Refactor storage adapter',
      );

      const sessionNoTask: GraphNode = {
        id: 'session:s2',
        label: 's2',
        kind: 'session',
        sessionId: 'abcdef123',
      };
      expect(shortNodeDisplayLabel(sessionNoTask)).toBe('เซสชัน #abcdef');
    });
  });

  describe('fullNodeTooltipLabel', () => {
    it('returns rich descriptive tooltip text', () => {
      const fileNode: GraphNode = {
        id: 'file:src/main.ts',
        label: 'src/main.ts',
        kind: 'file',
      };
      expect(fullNodeTooltipLabel(fileNode)).toBe('ไฟล์: src/main.ts');

      const symNode: GraphNode = {
        id: 'symbol:startServer',
        label: 'startServer',
        kind: 'symbol',
      };
      expect(fullNodeTooltipLabel(symNode)).toBe('ฟังก์ชัน/คลาส: startServer');

      const sessionNode: GraphNode = {
        id: 'session:s1',
        label: 's1',
        kind: 'session',
        sessionId: '1234567890',
        currentTask: 'Build UI',
      };
      expect(fullNodeTooltipLabel(sessionNode)).toBe('เซสชัน #12345678: Build UI');

      const noteNode: GraphNode = {
        id: 'note:n1',
        label: 'My Note',
        kind: 'note',
        summary: 'A short summary for note 1',
      };
      expect(fullNodeTooltipLabel(noteNode)).toBe(
        'My Note — A short summary for note 1',
      );
    });
  });
});
