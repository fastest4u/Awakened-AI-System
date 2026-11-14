import type { GraphNode } from '@/api/types';

/**
 * Returns human-readable Thai label for node kind / subkind.
 */
export function humanKindLabel(node: GraphNode | null | undefined): string {
  if (!node) return '';
  if (node.kind === 'session') return 'เซสชันการทำงานของ AI (AI Session)';
  if (node.kind === 'file') return 'ไฟล์ซอร์สโค้ด (Project File)';
  if (node.kind === 'symbol') return 'ฟังก์ชัน / คลาส (Code Symbol)';
  const sk = String(node.subkind || 'insight').toLowerCase();
  if (sk === 'adr') return 'การตัดสินใจสถาปัตยกรรม (ADR)';
  if (sk === 'mistake') return 'ข้อผิดพลาดที่แก้ไขแล้ว (Mistake)';
  if (sk === 'session-log') return 'บันทึกสรุปเซสชัน (Session Log)';
  return 'บทเรียนและเทคนิคสำคัญ (Insight)';
}

/**
 * Returns short display label (<= 30 chars).
 * For files: returns the filename basename (e.g. `views-and-web-components.ts`).
 * For sessions: returns the currentTask (stripped of ADR:/Mistake:/Insight:) or `เซสชัน #<id>`.
 * For notes/symbols: strips category prefixes and truncates with `…` if > 30 chars.
 */
export function shortNodeDisplayLabel(node: GraphNode | null | undefined): string {
  if (!node) return '';
  const raw = String(node.label || '');
  let text = '';
  if (node.kind === 'file') {
    const parts = raw.split(/[\\/]/);
    text = parts[parts.length - 1] || raw;
  } else if (node.kind === 'session') {
    const task = String(node.currentTask || '')
      .replace(/^(?:ADR|Mistake|Insight):\s*/i, '')
      .trim();
    if (task && task !== 'AI Agent Working Session') {
      text = task.slice(0, 28);
    } else {
      text = 'เซสชัน #' + String(node.sessionId || '').slice(0, 6);
    }
  } else {
    text = raw.replace(/^(?:ADR|Mistake|Insight):\s*/i, '').trim();
  }
  return text.length > 30 ? text.slice(0, 29) + '…' : text;
}

/**
 * Returns rich full tooltip label for hover / <title>.
 */
export function fullNodeTooltipLabel(node: GraphNode | null | undefined): string {
  if (!node) return '';
  if (node.kind === 'file') return 'ไฟล์: ' + String(node.label || '');
  if (node.kind === 'symbol') return 'ฟังก์ชัน/คลาส: ' + String(node.label || '');
  if (node.kind === 'session') {
    return (
      'เซสชัน #' +
      String(node.sessionId || '').slice(0, 8) +
      ': ' +
      String(node.currentTask || node.label || '')
    );
  }
  return (
    String(node.label || '') +
    (node.summary ? ' — ' + String(node.summary).slice(0, 140) : '')
  );
}
