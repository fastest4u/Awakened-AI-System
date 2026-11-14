import { describe, it, expect } from 'vitest';
import type { GraphEdge, GraphNode } from '@/api/types';
import {
  CARD_DIMENSIONS,
  selectVisibleGraphNodes,
  buildSeedLayout,
  computeElkGraphLayout,
  type ElkLayoutPosition,
} from './elk-graph-layout';

function boxesOverlap(a: ElkLayoutPosition, b: ElkLayoutPosition): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

function assertZeroOverlaps(positions: ReadonlyMap<string, ElkLayoutPosition>) {
  const entries = Array.from(positions.entries());
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [idA, boxA] = entries[i];
      const [idB, boxB] = entries[j];
      expect(
        boxesOverlap(boxA, boxB),
        `Expected ${idA} and ${idB} not to overlap (${JSON.stringify(boxA)} vs ${JSON.stringify(boxB)})`,
      ).toBe(false);
    }
  }
}

describe('elk-graph-layout', () => {
  it('defines distinct positive dimensions for all four custom card types', () => {
    expect(CARD_DIMENSIONS.session.width).toBeGreaterThan(200);
    expect(CARD_DIMENSIONS.note.width).toBeGreaterThan(CARD_DIMENSIONS.session.width);
    expect(CARD_DIMENSIONS.file.width).toBeGreaterThan(200);
    expect(CARD_DIMENSIONS.symbol.height).toBeLessThan(CARD_DIMENSIONS.note.height);
  });

  it('selectVisibleGraphNodes caps 600 nodes to <= 56 while preserving selected and highlighted nodes', () => {
    const kinds: Array<GraphNode['kind']> = ['session', 'note', 'file', 'symbol'];
    const nodes: GraphNode[] = [];
    for (let i = 0; i < 600; i++) {
      const kind = kinds[i % kinds.length];
      nodes.push({ id: `${kind}:${i}`, label: `${kind} ${i}`, kind });
    }
    const highlighted = new Set(['session:500', 'note:501', 'file:502', 'symbol:503']);
    const visible = selectVisibleGraphNodes(nodes, highlighted, 'note:501', 56);

    expect(visible.length).toBeLessThanOrEqual(56);
    for (const id of highlighted) {
      expect(visible.some((n) => n.id === id)).toBe(true);
    }
  });

  it('computeElkGraphLayout in flow mode enforces left-to-right column order and zero card overlaps even with reversed created-in-session edges', async () => {
    const nodes: GraphNode[] = [
      { id: 'session:s1', label: 'Session 1', kind: 'session', sessionId: 's1', currentTask: 'Auth refactor' },
      { id: 'note:n1', label: 'ADR 1', kind: 'note', recordId: 'n1', sessionId: 's1', subkind: 'adr' },
      { id: 'note:n2', label: 'Mistake 2', kind: 'note', recordId: 'n2', sessionId: 's1', subkind: 'mistake' },
      { id: 'file:src/a.ts', label: 'src/a.ts', kind: 'file' },
      { id: 'file:src/b.ts', label: 'src/b.ts', kind: 'file' },
      { id: 'symbol:fnA', label: 'fnA', kind: 'symbol' },
      { id: 'symbol:fnB', label: 'fnB', kind: 'symbol' },
    ];
    const edges: GraphEdge[] = [
      // Raw DB edges often go note -> session for created-in-session
      { source: 'note:n1', target: 'session:s1', relation: 'created-in-session' },
      { source: 'note:n2', target: 'session:s1', relation: 'created-in-session' },
      { source: 'note:n1', target: 'file:src/a.ts', relation: 'touches-file' },
      { source: 'note:n2', target: 'file:src/b.ts', relation: 'touches-file' },
      // Skip-layer note -> symbol edge
      { source: 'note:n1', target: 'symbol:fnA', relation: 'mentions-symbol' },
      { source: 'file:src/b.ts', target: 'symbol:fnB', relation: 'defines-symbol' },
    ];
    const highlighted = new Set(nodes.map((n) => n.id));
    const result = await computeElkGraphLayout(nodes, edges, 'flow', 'note:n1', highlighted);

    expect(result.visibleNodes).toHaveLength(nodes.length);
    assertZeroOverlaps(result.positions);

    const s1 = result.positions.get('session:s1')!;
    const n1 = result.positions.get('note:n1')!;
    const n2 = result.positions.get('note:n2')!;
    const fA = result.positions.get('file:src/a.ts')!;
    const fB = result.positions.get('file:src/b.ts')!;
    const symA = result.positions.get('symbol:fnA')!;
    const symB = result.positions.get('symbol:fnB')!;

    expect(s1.x + s1.width).toBeLessThan(n1.x);
    expect(s1.x + s1.width).toBeLessThan(n2.x);
    expect(Math.max(n1.x + n1.width, n2.x + n2.width)).toBeLessThan(fA.x);
    expect(Math.max(n1.x + n1.width, n2.x + n2.width)).toBeLessThan(fB.x);
    expect(Math.max(fA.x + fA.width, fB.x + fB.width)).toBeLessThan(symA.x);
    expect(Math.max(fA.x + fA.width, fB.x + fB.width)).toBeLessThan(symB.x);
  });

  it('computeElkGraphLayout and buildSeedLayout in orbital mode center selected node and eliminate card overlaps across 12+ surrounding cards', async () => {
    const nodes: GraphNode[] = [
      { id: 'session:s1', label: 'Session 1', kind: 'session', sessionId: 's1' },
      { id: 'note:center', label: 'Center ADR', kind: 'note', recordId: 'center', sessionId: 's1', subkind: 'adr' },
      { id: 'note:rel1', label: 'Related Mistake', kind: 'note', recordId: 'rel1', sessionId: 's1', subkind: 'mistake' },
      ...Array.from({ length: 5 }, (_, i) => ({
        id: `file:src/f${i}.ts`,
        label: `src/f${i}.ts`,
        kind: 'file' as const,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `symbol:sym${i}`,
        label: `sym${i}`,
        kind: 'symbol' as const,
      })),
    ];
    const edges: GraphEdge[] = [
      { source: 'note:center', target: 'session:s1', relation: 'created-in-session' },
      { source: 'note:center', target: 'note:rel1', relation: 'causal-triad' },
      ...Array.from({ length: 5 }, (_, i) => ({
        source: 'note:center',
        target: `file:src/f${i}.ts`,
        relation: 'touches-file' as const,
      })),
      ...Array.from({ length: 7 }, (_, i) => ({
        source: 'note:center',
        target: `symbol:sym${i}`,
        relation: 'mentions-symbol' as const,
      })),
    ];
    const highlighted = new Set(nodes.map((n) => n.id));

    const seed = buildSeedLayout(nodes, edges, 'orbital', 'note:center', highlighted);
    expect(seed.visibleNodes).toHaveLength(nodes.length);
    assertZeroOverlaps(seed.positions);

    const elkResult = await computeElkGraphLayout(nodes, edges, 'orbital', 'note:center', highlighted);
    expect(elkResult.visibleNodes).toHaveLength(nodes.length);
    assertZeroOverlaps(elkResult.positions);

    const centerBox = elkResult.positions.get('note:center')!;
    const centerMidX = centerBox.x + centerBox.width / 2;
    const allMidX = Array.from(elkResult.positions.values()).map((b) => b.x + b.width / 2);
    const minMidX = Math.min(...allMidX);
    const maxMidX = Math.max(...allMidX);
    expect(centerMidX).toBeGreaterThan(minMidX);
    expect(centerMidX).toBeLessThan(maxMidX);
  });
});
