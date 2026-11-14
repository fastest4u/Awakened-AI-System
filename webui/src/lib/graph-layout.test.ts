import { describe, it, expect } from 'vitest';
import {
  computeNeighborhood,
  filterGraph,
  computeFlowLayout,
  computeOrbitalLayout,
  pickSpotlightLabels,
  findMatchingNode,
  selectFocusedNodesAndEdges,
} from './graph-layout';
import type { GraphNode, GraphEdge, GraphResponse } from '@/api/types';

describe('graph-layout', () => {
  it('caps 600 nodes to 56 in flow and orbital layouts', () => {
    const kinds: Array<GraphNode['kind']> = ['session', 'note', 'file', 'symbol'];
    const nodes: GraphNode[] = [];
    kinds.forEach((k) => {
      for (let i = 0; i < 150; i++) {
        nodes.push({
          id: `${k}:${i}`,
          label: `${k} ${i}`,
          kind: k,
          sessionId: k === 'session' ? `sess-${i}` : undefined,
          recordId: k === 'note' ? `rec-${i}` : undefined,
        });
      }
    });

    const highlighted = new Set(['session:50', 'note:50', 'file:50', 'symbol:50']);

    // Flow layout
    const flow = computeFlowLayout(nodes, highlighted);
    expect(flow.positions.size).toBeLessThanOrEqual(56);
    expect(flow.width).toBe(960);
    expect(flow.height).toBe(14 * 44 + 76);

    // Each kind in flow has at most 14 nodes
    kinds.forEach((k) => {
      const colCount = nodes
        .filter((n) => n.kind === k && flow.positions.has(n.id))
        .length;
      expect(colCount).toBeLessThanOrEqual(14);
    });

    // Highlighted nodes must be preserved
    highlighted.forEach((id) => {
      expect(flow.positions.has(id)).toBe(true);
    });

    // Orbital layout
    const orbital = computeOrbitalLayout(nodes, highlighted);
    expect(orbital.positions.size).toBeLessThanOrEqual(56);
    expect(orbital.width).toBe(960);
    expect(orbital.height).toBe(560);

    const sessionCount = nodes.filter(
      (n) => n.kind === 'session' && orbital.positions.has(n.id),
    ).length;
    const noteCount = nodes.filter(
      (n) => n.kind === 'note' && orbital.positions.has(n.id),
    ).length;
    const fileCount = nodes.filter(
      (n) => n.kind === 'file' && orbital.positions.has(n.id),
    ).length;
    const symCount = nodes.filter(
      (n) => n.kind === 'symbol' && orbital.positions.has(n.id),
    ).length;

    expect(sessionCount).toBeLessThanOrEqual(12);
    expect(noteCount).toBeLessThanOrEqual(16);
    expect(fileCount).toBeLessThanOrEqual(14);
    expect(symCount).toBeLessThanOrEqual(14);

    highlighted.forEach((id) => {
      expect(orbital.positions.has(id)).toBe(true);
    });
  });

  it('flow geometry places columns at 122, 368, 628, 852 and computes height', () => {
    const nodes: GraphNode[] = [
      { id: 'session:1', label: 'Session 1', kind: 'session' },
      { id: 'session:2', label: 'Session 2', kind: 'session' },
      { id: 'session:3', label: 'Session 3', kind: 'session' },
      { id: 'note:1', label: 'Note 1', kind: 'note' },
      { id: 'note:2', label: 'Note 2', kind: 'note' },
      { id: 'file:1', label: 'File 1', kind: 'file' },
      { id: 'symbol:1', label: 'Symbol 1', kind: 'symbol' },
    ];

    const flow3 = computeFlowLayout(nodes, new Set());
    // 3 rows -> 3*44+76 = 208, Math.max(500, 208) = 500
    expect(flow3.height).toBe(500);
    expect(flow3.positions.get('session:1')?.x).toBe(122);
    expect(flow3.positions.get('note:1')?.x).toBe(368);
    expect(flow3.positions.get('file:1')?.x).toBe(628);
    expect(flow3.positions.get('symbol:1')?.x).toBe(852);

    // 14 rows -> 14*44+76 = 692
    const nodes14: GraphNode[] = [];
    for (let i = 0; i < 14; i++) {
      nodes14.push({ id: `note:${i}`, label: `Note ${i}`, kind: 'note' });
    }
    const flow14 = computeFlowLayout(nodes14, new Set());
    expect(flow14.height).toBe(14 * 44 + 76);
  });

  it('neighborhood includes multi-hop triangle fixture', () => {
    const nodes: GraphNode[] = [
      { id: 'session:s1', label: 'S1', kind: 'session', sessionId: 's1' },
      { id: 'note:n1', label: 'N1', kind: 'note', sessionId: 's1', recordId: 'n1' },
      { id: 'file:f1', label: 'F1', kind: 'file' },
      { id: 'symbol:sym1', label: 'Sym1', kind: 'symbol' },
      { id: 'note:other', label: 'Other', kind: 'note' },
    ];

    const edges: GraphEdge[] = [
      {
        source: 'session:s1',
        target: 'note:n1',
        relation: 'created-in-session',
      },
      {
        source: 'note:n1',
        target: 'file:f1',
        relation: 'touches-file',
      },
      {
        source: 'file:f1',
        target: 'symbol:sym1',
        relation: 'defines-symbol',
      },
    ];

    const hoodFromNote = computeNeighborhood('note:n1', edges, nodes);
    expect(hoodFromNote.has('note:n1')).toBe(true);
    expect(hoodFromNote.has('session:s1')).toBe(true);
    expect(hoodFromNote.has('file:f1')).toBe(true);
    expect(hoodFromNote.has('note:other')).toBe(false);

    const hoodFromFile = computeNeighborhood('file:f1', edges, nodes);
    expect(hoodFromFile.has('file:f1')).toBe(true);
    expect(hoodFromFile.has('note:n1')).toBe(true);
    expect(hoodFromFile.has('session:s1')).toBe(true);
  });

  it('filterGraph filters by q, kind, session and maintains edge endpoint validity', () => {
    const graphData: GraphResponse = {
      ok: true,
      projectRoot: 'C:/test',
      nodes: [
        { id: 'session:s1', label: 'AI Worker Session', kind: 'session', sessionId: 's1', currentTask: 'Refactor auth' },
        { id: 'session:s2', label: 'AI Worker Session 2', kind: 'session', sessionId: 's2', currentTask: 'Build UI' },
        { id: 'note:n1', label: 'Token Expiry', kind: 'note', sessionId: 's1', recordId: 'n1', summary: 'JWT token details' },
        { id: 'note:n2', label: 'Button Design', kind: 'note', sessionId: 's2', recordId: 'n2', summary: 'Tailwind styling' },
        { id: 'file:auth.ts', label: 'src/auth.ts', kind: 'file' },
      ],
      edges: [
        { source: 'session:s1', target: 'note:n1', relation: 'created-in-session' },
        { source: 'note:n1', target: 'file:auth.ts', relation: 'touches-file' },
        { source: 'session:s2', target: 'note:n2', relation: 'created-in-session' },
      ],
    };

    // Filter by kind
    const onlyNotes = filterGraph(graphData, { kind: 'note' });
    expect(onlyNotes.nodes.every((n) => n.kind === 'note')).toBe(true);
    expect(onlyNotes.nodes.length).toBe(2);
    expect(onlyNotes.edges.length).toBe(0); // no edges between notes directly

    // Filter by q
    const searchAuth = filterGraph(graphData, { q: 'auth' });
    expect(searchAuth.nodes.map((n) => n.id)).toEqual(['session:s1', 'file:auth.ts']);

    // Filter by session (raw id or prefixed)
    const session1Filtered = filterGraph(graphData, { session: 's1' });
    expect(session1Filtered.nodes.map((n) => n.id)).toContain('session:s1');
    expect(session1Filtered.nodes.map((n) => n.id)).toContain('note:n1');
    expect(session1Filtered.nodes.map((n) => n.id)).toContain('file:auth.ts');
    expect(session1Filtered.nodes.map((n) => n.id)).not.toContain('session:s2');
  });

  it('findMatchingNode resolves raw or prefixed IDs', () => {
    const nodes: GraphNode[] = [
      { id: 'session:sess-123', label: 'S1', kind: 'session', sessionId: 'sess-123' },
      { id: 'note:rec-456', label: 'N1', kind: 'note', recordId: 'rec-456' },
      { id: 'file:src/app.tsx', label: 'src/app.tsx', kind: 'file' },
    ];

    expect(findMatchingNode(nodes, 'note:rec-456')?.id).toBe('note:rec-456');
    expect(findMatchingNode(nodes, 'rec-456')?.id).toBe('note:rec-456');
    expect(findMatchingNode(nodes, 'sess-123')?.id).toBe('session:sess-123');
    expect(findMatchingNode(nodes, 'session:sess-123')?.id).toBe('session:sess-123');
    expect(findMatchingNode(nodes, 'src/app.tsx')?.id).toBe('file:src/app.tsx');
    expect(findMatchingNode(nodes, 'unknown')).toBeNull();
  });

  it('pickSpotlightLabels respects caps (<=10 total: <=2 sessions, <=3 notes, <=3 files, <=3 symbols)', () => {
    const nodes: GraphNode[] = [];
    const positions = new Map<string, { x: number; y: number }>();
    const highlighted = new Set<string>();

    for (let i = 0; i < 5; i++) {
      const sId = `session:${i}`;
      nodes.push({ id: sId, label: `S${i}`, kind: 'session' });
      positions.set(sId, { x: 100, y: 100 });
      highlighted.add(sId);

      const nId = `note:${i}`;
      nodes.push({ id: nId, label: `N${i}`, kind: 'note' });
      positions.set(nId, { x: 200, y: 200 });
      highlighted.add(nId);

      const fId = `file:${i}`;
      nodes.push({ id: fId, label: `F${i}`, kind: 'file' });
      positions.set(fId, { x: 300, y: 300 });
      highlighted.add(fId);

      const symId = `symbol:${i}`;
      nodes.push({ id: symId, label: `Sym${i}`, kind: 'symbol' });
      positions.set(symId, { x: 400, y: 400 });
      highlighted.add(symId);
    }

    const spotlights = pickSpotlightLabels(nodes, positions, 'session:0', highlighted);
    expect(spotlights.size).toBeLessThanOrEqual(10);
    expect(spotlights.has('session:0')).toBe(false); // excludes selected
  });

  it('pickSpotlightLabels excludes unrelated nodes when highlighted set is non-empty', () => {
    const nodes: GraphNode[] = [
      { id: 'note:center', label: 'Center Note', kind: 'note', sessionId: 's1' },
      { id: 'file:a.ts', label: 'src/a.ts', kind: 'file' },
      { id: 'file:b.ts', label: 'src/b.ts', kind: 'file' },
      { id: 'file:c.ts', label: 'src/c.ts', kind: 'file' },
      { id: 'file:d.ts', label: 'src/d.ts', kind: 'file' },
      { id: 'symbol:relSym', label: 'relSym', kind: 'symbol' },
      { id: 'note:unrelated', label: 'Unrelated Note', kind: 'note', sessionId: 's2' },
      { id: 'file:unrelated.ts', label: 'src/unrelated.ts', kind: 'file' },
      { id: 'symbol:unrelatedSym', label: 'unrelatedSym', kind: 'symbol' },
      { id: 'session:s2', label: 'Other Session', kind: 'session', sessionId: 's2' },
    ];
    const highlighted = new Set([
      'note:center',
      'file:a.ts',
      'file:b.ts',
      'file:c.ts',
      'file:d.ts',
      'symbol:relSym',
    ]);
    const layout = computeOrbitalLayout(nodes, highlighted, 'note:center');
    const spotlights = pickSpotlightLabels(
      nodes,
      layout.positions,
      'note:center',
      highlighted,
    );

    expect(spotlights.has('note:center')).toBe(false);
    expect(spotlights.has('file:a.ts')).toBe(true);
    expect(spotlights.has('file:d.ts')).toBe(true);
    expect(spotlights.has('symbol:relSym')).toBe(true);
    expect(spotlights.has('note:unrelated')).toBe(false);
    expect(spotlights.has('file:unrelated.ts')).toBe(false);
    expect(spotlights.has('symbol:unrelatedSym')).toBe(false);
    expect(spotlights.has('session:s2')).toBe(false);
  });

  it('selectFocusedNodesAndEdges keeps only highlighted nodes and internal edges when focusRelatedOnly is true', () => {
    const nodes: GraphNode[] = [
      { id: 'session:s1', label: 'Session 1', kind: 'session', sessionId: 's1' },
      { id: 'note:n1', label: 'Note 1', kind: 'note', sessionId: 's1' },
      { id: 'file:f1', label: 'src/f1.ts', kind: 'file' },
      { id: 'note:n2', label: 'Unrelated Note', kind: 'note', sessionId: 's2' },
      { id: 'file:f2', label: 'src/f2.ts', kind: 'file' },
    ];
    const edges: GraphEdge[] = [
      { source: 'note:n1', target: 'session:s1', relation: 'created-in-session' },
      { source: 'note:n1', target: 'file:f1', relation: 'touches-file' },
      { source: 'note:n2', target: 'file:f2', relation: 'touches-file' },
    ];
    const highlighted = new Set(['session:s1', 'note:n1', 'file:f1']);

    const focused = selectFocusedNodesAndEdges({ nodes, edges }, highlighted, true);
    expect(focused.nodes.map((n) => n.id)).toEqual([
      'session:s1',
      'note:n1',
      'file:f1',
    ]);
    expect(focused.edges).toHaveLength(2);

    const unfocused = selectFocusedNodesAndEdges({ nodes, edges }, highlighted, false);
    expect(unfocused.nodes).toHaveLength(5);
    expect(unfocused.edges).toHaveLength(3);
  });

  it('computeNeighborhood for note traces defines-symbol from touched files when direct mentions-symbol count is 0', () => {
    const nodes: GraphNode[] = [
      { id: 'session:s1', label: 'Session 1', kind: 'session', sessionId: 's1' },
      { id: 'note:n1', label: 'Note 1', kind: 'note', sessionId: 's1' },
      { id: 'file:f1', label: 'src/f1.ts', kind: 'file' },
      { id: 'symbol:symA', label: 'symA', kind: 'symbol' },
      { id: 'symbol:symOther', label: 'symOther', kind: 'symbol' },
    ];
    const edges: GraphEdge[] = [
      { source: 'note:n1', target: 'file:f1', relation: 'touches-file' },
      { source: 'file:f1', target: 'symbol:symA', relation: 'defines-symbol' },
    ];

    const neighborhood = computeNeighborhood('note:n1', edges, nodes);
    expect(neighborhood.has('session:s1')).toBe(true);
    expect(neighborhood.has('file:f1')).toBe(true);
    expect(neighborhood.has('symbol:symA')).toBe(true);
    expect(neighborhood.has('symbol:symOther')).toBe(false);
  });
});
