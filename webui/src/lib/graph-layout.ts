import type {
  GraphNode,
  GraphEdge,
  GraphResponse,
} from '@/api/types';

export interface LayoutPosition {
  x: number;
  y: number;
  angle?: number;
}

export interface FlowLayoutResult {
  positions: Map<string, LayoutPosition>;
  width: 960;
  height: number;
  visibleNodes: GraphNode[];
}

export interface OrbitalLayoutResult {
  positions: Map<string, LayoutPosition>;
  width: 960;
  height: 560;
  visibleNodes: GraphNode[];
}

/**
 * Finds a matching node from search query / param `node` which may be
 * a raw recordId, a prefixed ID (`note:xxx`, `session:xxx`), or a path/symbol.
 */
export function findMatchingNode(
  nodes: readonly GraphNode[],
  target: string | null | undefined,
): GraphNode | null {
  if (!target) return null;
  const raw = target.trim();
  if (!raw) return null;

  // 1. Exact ID match
  let found = nodes.find((n) => n.id === raw);
  if (found) return found;

  // 2. Exact recordId match
  found = nodes.find((n) => n.recordId === raw);
  if (found) return found;

  // 3. note:<raw> match
  found = nodes.find((n) => n.id === `note:${raw}`);
  if (found) return found;

  // 4. session:<raw> match
  found = nodes.find((n) => n.id === `session:${raw}` || n.sessionId === raw);
  if (found) return found;

  // 5. file:<raw> match
  found = nodes.find((n) => n.id === `file:${raw}`);
  if (found) return found;

  // 6. symbol:<raw> match
  found = nodes.find((n) => n.id === `symbol:${raw}`);
  if (found) return found;

  // 7. Strip prefix and try matching recordId or sessionId
  if (raw.startsWith('note:')) {
    const stripped = raw.slice(5);
    found = nodes.find((n) => n.recordId === stripped || n.id === stripped);
    if (found) return found;
  }
  if (raw.startsWith('session:')) {
    const stripped = raw.slice(8);
    found = nodes.find((n) => n.sessionId === stripped || n.id === stripped);
    if (found) return found;
  }

  return null;
}

/**
 * Computes multi-hop human story neighborhood around selectedNode
 * (Session -> Note -> File -> Symbol), matching legacy controllers.ts:801-850.
 */
export function computeNeighborhood(
  selectedId: string | null | undefined,
  edges: readonly GraphEdge[],
  nodes?: readonly GraphNode[],
): Set<string> {
  const highlighted = new Set<string>();
  if (!selectedId) return highlighted;

  highlighted.add(selectedId);
  const nodeById = new Map<string, GraphNode>();
  if (nodes) {
    for (const n of nodes) {
      nodeById.set(n.id, n);
    }
  }

  const selectedNode = nodeById.get(selectedId);
  const kind =
    selectedNode?.kind ||
    (selectedId.startsWith('session:')
      ? 'session'
      : selectedId.startsWith('note:')
        ? 'note'
        : selectedId.startsWith('file:')
          ? 'file'
          : selectedId.startsWith('symbol:')
            ? 'symbol'
            : undefined);

  if (kind === 'note') {
    const sessId = selectedNode?.sessionId;
    if (sessId) {
      highlighted.add(`session:${sessId}`);
    }
    for (const e of edges) {
      if (e.target === selectedId) highlighted.add(e.source);
      if (e.source === selectedId) highlighted.add(e.target);
    }
  } else if (kind === 'session') {
    const noteIds = new Set<string>();
    const sessId = selectedNode?.sessionId || selectedId.replace(/^session:/, '');
    for (const e of edges) {
      if (e.source === selectedId || e.target === selectedId) {
        highlighted.add(e.source);
        highlighted.add(e.target);
        if (e.target.startsWith('note:') || nodeById.get(e.target)?.kind === 'note') {
          noteIds.add(e.target);
        }
      }
    }
    if (nodes) {
      for (const n of nodes) {
        if (
          n.kind === 'note' &&
          (n.sessionId === sessId || n.sessionId === selectedId)
        ) {
          highlighted.add(n.id);
          noteIds.add(n.id);
        }
      }
    }
    for (const e of edges) {
      if (noteIds.has(e.source)) {
        highlighted.add(e.target);
      }
    }
  } else if (kind === 'file' || kind === 'symbol') {
    const noteIds = new Set<string>();
    for (const e of edges) {
      if (e.target === selectedId || e.source === selectedId) {
        highlighted.add(e.source);
        highlighted.add(e.target);
        if (e.source.startsWith('note:') || nodeById.get(e.source)?.kind === 'note') {
          noteIds.add(e.source);
        }
      }
    }
    for (const nid of noteIds) {
      const noteNode = nodeById.get(nid);
      if (noteNode && noteNode.sessionId) {
        highlighted.add(`session:${noteNode.sessionId}`);
      }
      for (const e of edges) {
        if (e.target === nid) highlighted.add(e.source);
        if (
          e.source === nid &&
          ((kind === 'file' && e.relation === 'mentions-symbol') ||
            (kind === 'symbol' && e.relation === 'touches-file'))
        ) {
          highlighted.add(e.target);
        }
      }
    }
  } else {
    for (const e of edges) {
      if (e.target === selectedId) highlighted.add(e.source);
      if (e.source === selectedId) highlighted.add(e.target);
    }
  }

  return highlighted;
}

/**
 * Filters the graph nodes and edges according to kind, q search string, and session ID.
 */
export function filterGraph(
  g: GraphResponse,
  f: {
    q?: string;
    kind?: 'all' | 'session' | 'note' | 'file' | 'symbol';
    session?: string;
  },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const rawNodes = g.nodes || [];
  const rawEdges = g.edges || [];

  let filtered =
    !f.kind || f.kind === 'all'
      ? rawNodes
      : rawNodes.filter((n) => n.kind === f.kind);

  if (f.q && f.q.trim()) {
    const q = f.q.trim().toLowerCase();
    filtered = filtered.filter(
      (n) =>
        String(n.label || '').toLowerCase().includes(q) ||
        String(n.summary || '').toLowerCase().includes(q) ||
        String(n.currentTask || '').toLowerCase().includes(q),
    );
  }

  if (f.session && f.session !== 'all') {
    const targetSessionNodeId = f.session.startsWith('session:')
      ? f.session
      : `session:${f.session}`;
    const rawSessionId = f.session.replace(/^session:/, '');

    const noteIdsInSession = new Set(
      rawNodes
        .filter(
          (n) =>
            n.kind === 'note' &&
            (n.sessionId === rawSessionId || n.sessionId === f.session),
        )
        .map((n) => n.id),
    );

    for (const e of rawEdges) {
      if (
        (e.source === targetSessionNodeId || e.source === f.session) &&
        e.relation === 'created-in-session'
      ) {
        noteIdsInSession.add(e.target);
      }
    }

    const connectedFileOrSym = new Set<string>();
    for (const e of rawEdges) {
      if (noteIdsInSession.has(e.source)) {
        connectedFileOrSym.add(e.target);
      }
    }

    filtered = filtered.filter(
      (n) =>
        n.id === targetSessionNodeId ||
        n.id === f.session ||
        (n.kind === 'session' &&
          (n.sessionId === rawSessionId || n.id === targetSessionNodeId)) ||
        noteIdsInSession.has(n.id) ||
        connectedFileOrSym.has(n.id),
    );
  }

  const allowedIds = new Set(filtered.map((n) => n.id));
  const edges = rawEdges.filter(
    (e) => allowedIds.has(e.source) && allowedIds.has(e.target),
  );

  return { nodes: filtered, edges };
}

/**
 * Computes 4-column flow layout:
 * x = 122 (Session), 368 (Memory/Note), 628 (File), 852 (Symbol).
 * Caps <= 14 per column, <= 56 total. Highlighted items first.
 * height = max(500, maxRows * 44 + 76).
 */
export function computeFlowLayout(
  nodes: readonly GraphNode[],
  highlighted: ReadonlySet<string>,
): FlowLayoutResult {
  const maxPerCol = 14;

  const sessionCol = nodes.filter((n) => n.kind === 'session');
  const noteCol = nodes.filter((n) => n.kind === 'note');
  const fileCol = nodes.filter((n) => n.kind === 'file');
  const symbolCol = nodes.filter((n) => n.kind === 'symbol');

  const sliceCol = (arr: GraphNode[]) => {
    if (arr.length <= maxPerCol) return arr;
    const hi = arr.filter((n) => highlighted.has(n.id)).slice(0, maxPerCol);
    const rest = arr
      .filter((n) => !highlighted.has(n.id))
      .slice(0, Math.max(0, maxPerCol - hi.length));
    const keep = new Set([...hi, ...rest].map((n) => n.id));
    return arr.filter((n) => keep.has(n.id)).slice(0, maxPerCol);
  };

  const sVis = sliceCol(sessionCol);
  const nVis = sliceCol(noteCol);
  const fVis = sliceCol(fileCol);
  const symVis = sliceCol(symbolCol);

  const visibleNodes = [...sVis, ...nVis, ...fVis, ...symVis];
  const maxRows = Math.max(
    sVis.length,
    nVis.length,
    fVis.length,
    symVis.length,
    1,
  );
  const height = Math.max(500, maxRows * 44 + 76);
  const positions = new Map<string, LayoutPosition>();

  const placeColumn = (colNodes: GraphNode[], colX: number) => {
    const count = colNodes.length;
    if (count === 0) return;
    const topPad = 68;
    const usableH = height - topPad - 30;
    const step = count === 1 ? 0 : Math.min(46, usableH / (count - 1));
    const totalSpan = step * (count - 1);
    const startY = Math.round(topPad + (usableH - totalSpan) / 2);
    colNodes.forEach((n, idx) => {
      positions.set(n.id, {
        x: colX,
        y: Math.round(startY + idx * step),
      });
    });
  };

  placeColumn(sVis, 122);
  placeColumn(nVis, 368);
  placeColumn(fVis, 628);
  placeColumn(symVis, 852);

  return {
    positions,
    width: 960,
    height,
    visibleNodes,
  };
}

/**
 * Computes orbital layout:
 * center = (480, 280), width = 960, height = 560.
 * r = 90 for sessions (<=12), r = 170 for notes (<=16),
 * r = 215 for symbols (<=14), r = 242 for files (<=14).
 * Total <= 56 nodes.
 */
export function computeOrbitalLayout(
  nodes: readonly GraphNode[],
  highlighted: ReadonlySet<string>,
  selectedId?: string | null,
): OrbitalLayoutResult {
  const width = 960;
  const height = 560;
  const cx = width / 2;
  const cy = height / 2;

  const sessionCol = nodes.filter((n) => n.kind === 'session');
  const noteCol = nodes.filter((n) => n.kind === 'note');
  const fileCol = nodes.filter((n) => n.kind === 'file');
  const symbolCol = nodes.filter((n) => n.kind === 'symbol');

  const sliceOrbital = (arr: GraphNode[], cap: number) => {
    if (arr.length <= cap) return arr;
    const priority = arr
      .filter((n) => (selectedId && n.id === selectedId) || highlighted.has(n.id))
      .slice(0, cap);
    const rest = arr
      .filter(
        (n) => !((selectedId && n.id === selectedId) || highlighted.has(n.id)),
      )
      .slice(0, Math.max(0, cap - priority.length));
    const keep = new Set([...priority, ...rest].map((n) => n.id));
    return arr.filter((n) => keep.has(n.id)).slice(0, cap);
  };

  const sOrb = sliceOrbital(sessionCol, 12);
  const nOrb = sliceOrbital(noteCol, 16);
  const fOrb = sliceOrbital(fileCol, 14);
  const symOrb = sliceOrbital(symbolCol, 14);

  const visibleNodes = [...sOrb, ...nOrb, ...fOrb, ...symOrb];
  const outerRing = [...fOrb, ...symOrb];
  const positions = new Map<string, LayoutPosition>();

  sOrb.forEach((n, idx) => {
    const angle =
      (2 * Math.PI * idx) / Math.max(sOrb.length, 1) - Math.PI / 2;
    const radius = sOrb.length <= 1 ? 0 : 90;
    positions.set(n.id, {
      x: Math.round(cx + radius * Math.cos(angle)),
      y: Math.round(cy + radius * Math.sin(angle)),
      angle,
    });
  });

  nOrb.forEach((n, idx) => {
    const angle =
      (2 * Math.PI * idx) / Math.max(nOrb.length, 1) - Math.PI / 2 + 0.2;
    const radius = 170;
    positions.set(n.id, {
      x: Math.round(cx + radius * Math.cos(angle)),
      y: Math.round(cy + radius * Math.sin(angle)),
      angle,
    });
  });

  outerRing.forEach((n, idx) => {
    const angle =
      (2 * Math.PI * idx) / Math.max(outerRing.length, 1) - Math.PI / 2;
    const radius = n.kind === 'file' ? 242 : 215;
    positions.set(n.id, {
      x: Math.round(cx + radius * Math.cos(angle)),
      y: Math.round(cy + radius * Math.sin(angle)),
      angle,
    });
  });

  return {
    positions,
    width,
    height,
    visibleNodes,
  };
}

/**
 * Selects spotlight labels for orbital mode:
 * <= 10 items (up to 2 sessions, 3 notes, 3 files, 3 symbols), excluding selected node.
 */
export function pickSpotlightLabels(
  nodes: readonly GraphNode[],
  positions: ReadonlyMap<string, LayoutPosition>,
  selectedId: string | null | undefined,
  highlighted: ReadonlySet<string>,
): Set<string> {
  const visible = nodes.filter(
    (n) => positions.has(n.id) && n.id !== selectedId,
  );

  const pickForKind = (kind: GraphNode['kind'], cap: number) => {
    const list = visible.filter((n) => n.kind === kind);
    const hi = list.filter((n) => highlighted.has(n.id)).slice(0, cap);
    const rest = list
      .filter((n) => !highlighted.has(n.id))
      .slice(0, Math.max(0, cap - hi.length));
    return [...hi, ...rest];
  };

  const sessions = pickForKind('session', 2);
  const notes = pickForKind('note', 3);
  const files = pickForKind('file', 3);
  const symbols = pickForKind('symbol', 3);

  const combined = [...sessions, ...notes, ...files, ...symbols].slice(0, 10);
  return new Set(combined.map((n) => n.id));
}
