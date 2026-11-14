import ELKModule from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode } from 'elkjs/lib/elk-api';
import type { GraphEdge, GraphNode } from '@/api/types';

export const CARD_DIMENSIONS: Record<
  GraphNode['kind'],
  { width: number; height: number }
> = {
  session: { width: 256, height: 108 },
  note: { width: 304, height: 148 },
  file: { width: 244, height: 86 },
  symbol: { width: 212, height: 76 },
};

export interface ElkLayoutPosition {
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
}

export interface ElkLayoutResult {
  positions: Map<string, ElkLayoutPosition>;
  width: number;
  height: number;
  visibleNodes: GraphNode[];
  mode: 'flow' | 'orbital';
}

const KIND_RANK: Record<GraphNode['kind'], number> = {
  session: 0,
  note: 1,
  file: 2,
  symbol: 3,
};

const KIND_PRIORITY: Record<GraphNode['kind'], number> = {
  note: 0,
  session: 1,
  file: 2,
  symbol: 3,
};

const CARD_GAP_X = 104;
const CARD_GAP_Y = 28;
const STAGE_PADDING = 48;

type ElkConstructor = new () => {
  layout: (graph: ElkNode) => Promise<ElkNode>;
};

let elkInstance: InstanceType<ElkConstructor> | null = null;

function getElkInstance(): InstanceType<ElkConstructor> {
  if (!elkInstance) {
    const ResolvedELK = (
      (ELKModule as unknown as { default?: ElkConstructor }).default ??
      (ELKModule as unknown as ElkConstructor)
    );
    elkInstance = new ResolvedELK();
  }
  return elkInstance;
}

function getCardDimensions(kind: GraphNode['kind']): {
  width: number;
  height: number;
} {
  return CARD_DIMENSIONS[kind] ?? CARD_DIMENSIONS.note;
}

function boxesOverlapWithPadding(
  a: ElkLayoutPosition,
  b: ElkLayoutPosition,
  padding = 12,
): boolean {
  return !(
    a.x + a.width + padding <= b.x ||
    b.x + b.width + padding <= a.x ||
    a.y + a.height + padding <= b.y ||
    b.y + b.height + padding <= a.y
  );
}

/**
 * Resolves any remaining card overlaps deterministically while keeping `pinnedId`
 * anchored at the center in orbital mode or pushing vertically in flow mode.
 */
function resolveBoxOverlaps(
  positions: Map<string, ElkLayoutPosition>,
  pinnedId: string | null,
  mode: 'flow' | 'orbital',
  padding = 20,
): void {
  const ids = Array.from(positions.keys());
  if (ids.length <= 1) return;

  const pinnedBox = pinnedId ? positions.get(pinnedId) : undefined;
  const centerX = pinnedBox ? pinnedBox.x + pinnedBox.width / 2 : 760;
  const centerY = pinnedBox ? pinnedBox.y + pinnedBox.height / 2 : 460;

  for (let pass = 0; pass < 36; pass++) {
    let moved = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const idA = ids[i];
        const idB = ids[j];
        const a = positions.get(idA)!;
        const b = positions.get(idB)!;
        if (!boxesOverlapWithPadding(a, b, padding)) continue;

        moved = true;
        const aMidX = a.x + a.width / 2;
        const aMidY = a.y + a.height / 2;
        const bMidX = b.x + b.width / 2;
        const bMidY = b.y + b.height / 2;

        const overlapX =
          (a.width + b.width) / 2 + padding - Math.abs(bMidX - aMidX);
        const overlapY =
          (a.height + b.height) / 2 + padding - Math.abs(bMidY - aMidY);

        if (mode === 'flow') {
          // Keep horizontal columns intact by separating vertically
          const shift = Math.max(overlapY, padding);
          if (aMidY <= bMidY) {
            b.y += shift;
          } else {
            a.y += shift;
          }
          continue;
        }

        // Orbital mode: preserve pinned center card and push outer card radially/away
        const aPinned = idA === pinnedId;
        const bPinned = idB === pinnedId;
        let dx = bMidX - aMidX;
        let dy = bMidY - aMidY;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
          dx = Math.cos(i * 1.17) * 8;
          dy = Math.sin(j * 1.37) * 8;
        }

        const preferX = overlapX < overlapY * 0.9;
        const moveX = preferX ? overlapX + 6 : Math.sign(dx) * Math.min(overlapX * 0.45, 24);
        const moveY = !preferX ? overlapY + 6 : Math.sign(dy) * Math.min(overlapY * 0.45, 24);

        const pushAwayFromCenter = (target: ElkLayoutPosition, signFallback: number) => {
          const tMidX = target.x + target.width / 2;
          const tMidY = target.y + target.height / 2;
          const dirX = Math.sign(tMidX - centerX) || signFallback;
          const dirY = Math.sign(tMidY - centerY) || signFallback;
          target.x += dirX * Math.max(Math.abs(moveX), preferX ? overlapX + 8 : 8);
          target.y += dirY * Math.max(Math.abs(moveY), !preferX ? overlapY + 8 : 8);
        };

        if (aPinned) {
          pushAwayFromCenter(b, 1);
        } else if (bPinned) {
          pushAwayFromCenter(a, -1);
        } else if (preferX) {
          const dir = dx >= 0 ? 1 : -1;
          a.x -= dir * (overlapX / 2 + 4);
          b.x += dir * (overlapX / 2 + 4);
        } else {
          const dir = dy >= 0 ? 1 : -1;
          a.y -= dir * (overlapY / 2 + 4);
          b.y += dir * (overlapY / 2 + 4);
        }
      }
    }
    if (!moved) break;
  }

  // Shift all positions so coordinates stay inside positive stage margins
  let minX = Infinity;
  let minY = Infinity;
  for (const box of positions.values()) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
  }
  const offsetX = Number.isFinite(minX) && minX < STAGE_PADDING ? STAGE_PADDING - minX : 0;
  const offsetY = Number.isFinite(minY) && minY < STAGE_PADDING ? STAGE_PADDING - minY : 0;
  if (offsetX !== 0 || offsetY !== 0) {
    for (const box of positions.values()) {
      box.x += offsetX;
      box.y += offsetY;
    }
  }
}

function measureStageBounds(positions: ReadonlyMap<string, ElkLayoutPosition>): {
  width: number;
  height: number;
} {
  let maxX = 960;
  let maxY = 620;
  for (const box of positions.values()) {
    maxX = Math.max(maxX, box.x + box.width + STAGE_PADDING);
    maxY = Math.max(maxY, box.y + box.height + STAGE_PADDING);
  }
  return {
    width: Math.ceil(maxX),
    height: Math.ceil(maxY),
  };
}

/**
 * Selects up to `limit` high-signal nodes for crisp card rendering while always
 * retaining the selected node and its highlighted neighborhood.
 */
export function selectVisibleGraphNodes(
  nodes: readonly GraphNode[],
  highlightedIds: ReadonlySet<string>,
  selectedId?: string | null,
  limit = 56,
): GraphNode[] {
  if (nodes.length <= limit) {
    return [...nodes];
  }

  const ordered: GraphNode[] = [];
  const added = new Set<string>();

  const pushNode = (node: GraphNode | undefined) => {
    if (!node || added.has(node.id) || ordered.length >= limit) return;
    added.add(node.id);
    ordered.push(node);
  };

  if (selectedId) {
    pushNode(nodes.find((n) => n.id === selectedId));
  }

  // Preserve highlighted nodes first (notes/sessions before peripheral symbols)
  const highlightedNodes = nodes
    .filter((n) => !added.has(n.id) && highlightedIds.has(n.id))
    .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  for (const node of highlightedNodes) {
    pushNode(node);
  }

  // Fill remaining slots with priority notes/sessions before files/symbols
  const remainingNodes = nodes
    .filter((n) => !added.has(n.id))
    .sort((a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  for (const node of remainingNodes) {
    pushNode(node);
  }

  return ordered;
}

function computeColumnStarts(): Record<GraphNode['kind'], number> {
  const sessionX = STAGE_PADDING;
  const noteX = sessionX + CARD_DIMENSIONS.session.width + CARD_GAP_X;
  const fileX = noteX + CARD_DIMENSIONS.note.width + CARD_GAP_X;
  const symbolX = fileX + CARD_DIMENSIONS.file.width + CARD_GAP_X;
  return {
    session: sessionX,
    note: noteX,
    file: fileX,
    symbol: symbolX,
  };
}

function buildOrbitalSeedPositions(
  visibleNodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  selectedId: string | null | undefined,
  highlightedIds: ReadonlySet<string>,
): { positions: Map<string, ElkLayoutPosition>; centerId: string | null } {
  const positions = new Map<string, ElkLayoutPosition>();
  if (visibleNodes.length === 0) {
    return { positions, centerId: null };
  }

  const centerNode =
    (selectedId ? visibleNodes.find((n) => n.id === selectedId) : undefined) ??
    visibleNodes.find((n) => n.kind === 'note') ??
    visibleNodes[0];

  const centerDim = getCardDimensions(centerNode.kind);
  const anchorX = 960;
  const anchorY = 640;

  positions.set(centerNode.id, {
    x: anchorX - centerDim.width / 2,
    y: anchorY - centerDim.height / 2,
    width: centerDim.width,
    height: centerDim.height,
  });

  // Track 1-hop direct connections so closely tied cards stay in the inner ring
  const directNeighborIds = new Set<string>();
  for (const edge of edges) {
    if (edge.source === centerNode.id) directNeighborIds.add(edge.target);
    if (edge.target === centerNode.id) directNeighborIds.add(edge.source);
  }

  const others = visibleNodes
    .filter((n) => n.id !== centerNode.id)
    .sort((a, b) => {
      const aDirect = directNeighborIds.has(a.id) ? 0 : 1;
      const bDirect = directNeighborIds.has(b.id) ? 0 : 1;
      if (aDirect !== bDirect) return aDirect - bDirect;
      const aHi = highlightedIds.has(a.id) ? 0 : 1;
      const bHi = highlightedIds.has(b.id) ? 0 : 1;
      if (aHi !== bHi) return aHi - bHi;
      return KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind];
    });

  // Split into concentric rings of balanced counts so cards have breathing room
  const ringCapacities = [8, 16, 24, 32];
  const rings: GraphNode[][] = [];
  let cursor = 0;
  for (const cap of ringCapacities) {
    if (cursor >= others.length) break;
    rings.push(others.slice(cursor, cursor + cap));
    cursor += cap;
  }
  if (cursor < others.length) {
    rings.push(others.slice(cursor));
  }

  let prevRadiusX = centerDim.width / 2 + 120;
  let prevRadiusY = centerDim.height / 2 + 110;

  for (let rIdx = 0; rIdx < rings.length; rIdx++) {
    const ring = rings[rIdx];
    const maxW = Math.max(...ring.map((n) => getCardDimensions(n.kind).width));
    const maxH = Math.max(...ring.map((n) => getCardDimensions(n.kind).height));
    // Guarantee minimum circumference spacing so adjacent cards on the ring do not collide
    const minCircX = (ring.length * (maxW + 32)) / (2 * Math.PI);
    const minCircY = (ring.length * (maxH + 28)) / (2 * Math.PI);
    const rx = Math.max(prevRadiusX + maxW * 0.85 + 80, minCircX);
    const ry = Math.max(prevRadiusY + maxH * 0.95 + 75, minCircY);

    prevRadiusX = rx;
    prevRadiusY = ry;

    const phaseOffset = rIdx % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / Math.max(ring.length, 2);

    for (let i = 0; i < ring.length; i++) {
      const node = ring[i];
      const dim = getCardDimensions(node.kind);
      const angle = phaseOffset + (2 * Math.PI * i) / ring.length;
      const cx = anchorX + Math.cos(angle) * rx;
      const cy = anchorY + Math.sin(angle) * ry;
      positions.set(node.id, {
        x: Math.round(cx - dim.width / 2),
        y: Math.round(cy - dim.height / 2),
        width: dim.width,
        height: dim.height,
        angle,
      });
    }
  }

  resolveBoxOverlaps(positions, centerNode.id, 'orbital', 20);
  return { positions, centerId: centerNode.id };
}

/**
 * Synchronous frame-0 layout so React Flow mounts glassmorphic cards immediately
 * without empty flicker before the async ELK refinement settles.
 */
export function buildSeedLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  mode: 'flow' | 'orbital',
  selectedId: string | null | undefined,
  highlightedIds: ReadonlySet<string>,
  limit = 56,
): ElkLayoutResult {
  const visibleNodes = selectVisibleGraphNodes(nodes, highlightedIds, selectedId, limit);

  if (mode === 'orbital') {
    const { positions } = buildOrbitalSeedPositions(
      visibleNodes,
      edges,
      selectedId,
      highlightedIds,
    );
    const bounds = measureStageBounds(positions);
    return {
      positions,
      width: bounds.width,
      height: bounds.height,
      visibleNodes,
      mode,
    };
  }

  const positions = new Map<string, ElkLayoutPosition>();
  const columnX = computeColumnStarts();
  const buckets: Record<GraphNode['kind'], GraphNode[]> = {
    session: [],
    note: [],
    file: [],
    symbol: [],
  };

  for (const node of visibleNodes) {
    buckets[node.kind].push(node);
  }

  // Sort each column so selected and highlighted cards surface at the top
  const kinds: Array<GraphNode['kind']> = ['session', 'note', 'file', 'symbol'];
  for (const kind of kinds) {
    buckets[kind].sort((a, b) => {
      if (a.id === selectedId) return -1;
      if (b.id === selectedId) return 1;
      const aHi = highlightedIds.has(a.id) ? 0 : 1;
      const bHi = highlightedIds.has(b.id) ? 0 : 1;
      return aHi - bHi;
    });

    let yCursor = STAGE_PADDING + 52;
    for (const node of buckets[kind]) {
      const dim = getCardDimensions(kind);
      positions.set(node.id, {
        x: columnX[kind],
        y: yCursor,
        width: dim.width,
        height: dim.height,
      });
      yCursor += dim.height + CARD_GAP_Y;
    }
  }

  const bounds = measureStageBounds(positions);
  return {
    positions,
    width: bounds.width,
    height: bounds.height,
    visibleNodes,
    mode,
  };
}

function buildCanonicalElkEdges(
  visibleIds: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, GraphNode>,
  edges: readonly GraphEdge[],
): ElkExtendedEdge[] {
  const seen = new Set<string>();
  const elkEdges: ElkExtendedEdge[] = [];

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    if (
      !visibleIds.has(edge.source) ||
      !visibleIds.has(edge.target) ||
      edge.source === edge.target
    ) {
      continue;
    }

    const srcNode = nodeById.get(edge.source)!;
    const tgtNode = nodeById.get(edge.target)!;
    const srcRank = KIND_RANK[srcNode.kind];
    const tgtRank = KIND_RANK[tgtNode.kind];

    // Orient ELK layout edges left-to-right across narrative columns
    // (e.g. raw `note -> session` `created-in-session` flows `session -> note` visually)
    const orientedSource = srcRank <= tgtRank ? edge.source : edge.target;
    const orientedTarget = srcRank <= tgtRank ? edge.target : edge.source;
    const dedupKey = `${orientedSource}->${orientedTarget}:${edge.relation}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    elkEdges.push({
      id: `elk-edge-${i}-${orientedSource}-${orientedTarget}`,
      sources: [orientedSource],
      targets: [orientedTarget],
    });
  }

  return elkEdges;
}

/**
 * Computes hierarchical 4-column Story Flow (`layered` + partitions) or concentric
 * Galaxy Orbital (`sporeOverlap`) positions via `elkjs` with zero-overlap guarantees.
 */
export async function computeElkGraphLayout(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  mode: 'flow' | 'orbital',
  selectedId: string | null | undefined,
  highlightedIds: ReadonlySet<string>,
  limit = 56,
): Promise<ElkLayoutResult> {
  const seed = buildSeedLayout(nodes, edges, mode, selectedId, highlightedIds, limit);
  const { visibleNodes } = seed;
  if (visibleNodes.length === 0) {
    return seed;
  }

  const elk = getElkInstance();
  const visibleIds = new Set(visibleNodes.map((n) => n.id));
  const nodeById = new Map(visibleNodes.map((n) => [n.id, n]));

  try {
    if (mode === 'flow') {
      const columnX = computeColumnStarts();
      const elkGraph: ElkNode = {
        id: 'root',
        layoutOptions: {
          'elk.algorithm': 'layered',
          'elk.direction': 'RIGHT',
          'elk.partitioning.activate': 'true',
          'elk.spacing.nodeNode': String(CARD_GAP_Y),
          'elk.layered.spacing.nodeNodeBetweenLayers': String(CARD_GAP_X),
          'elk.spacing.edgeNode': '24',
          'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
          'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
          'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
          'elk.padding': `[top=${STAGE_PADDING + 52},left=${STAGE_PADDING},bottom=${STAGE_PADDING},right=${STAGE_PADDING}]`,
        },
        children: visibleNodes.map((node) => {
          const dim = getCardDimensions(node.kind);
          return {
            id: node.id,
            width: dim.width,
            height: dim.height,
            layoutOptions: {
              'elk.partitioning.partition': String(KIND_RANK[node.kind]),
            },
          };
        }),
        edges: buildCanonicalElkEdges(visibleIds, nodeById, edges),
      };

      const laidOut = await elk.layout(elkGraph);
      const positions = new Map<string, ElkLayoutPosition>();

      for (const child of laidOut.children ?? []) {
        const orig = nodeById.get(child.id);
        if (!orig) continue;
        const dim = getCardDimensions(orig.kind);
        positions.set(child.id, {
          // Snap strictly to canonical narrative column X so all nodes in a role align
          // and left-to-right rank progression never overlaps or reverses
          x: columnX[orig.kind],
          y: Math.max(STAGE_PADDING + 52, Math.round(child.y ?? STAGE_PADDING + 52)),
          width: dim.width,
          height: dim.height,
        });
      }

      // Fill any missing node from seed & ensure zero overlaps per column
      for (const node of visibleNodes) {
        if (!positions.has(node.id)) {
          positions.set(node.id, seed.positions.get(node.id)!);
        }
      }
      resolveBoxOverlaps(positions, null, 'flow', 24);
      const bounds = measureStageBounds(positions);
      return {
        positions,
        width: bounds.width,
        height: bounds.height,
        visibleNodes,
        mode,
      };
    }

    // Orbital / Galaxy mode: seed concentric rings around center node, then refine with elk.sporeOverlap
    const centerNode =
      (selectedId ? visibleNodes.find((n) => n.id === selectedId) : undefined) ??
      visibleNodes.find((n) => n.kind === 'note') ??
      visibleNodes[0];

    const elkGraph: ElkNode = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'elk.sporeOverlap',
        'elk.spacing.nodeNode': '32',
        'elk.sporeOverlap.overlapsExisted': 'true',
      },
      children: visibleNodes.map((node) => {
        const seedBox = seed.positions.get(node.id)!;
        return {
          id: node.id,
          x: seedBox.x,
          y: seedBox.y,
          width: seedBox.width,
          height: seedBox.height,
        };
      }),
    };

    const laidOut = await elk.layout(elkGraph);
    const positions = new Map<string, ElkLayoutPosition>();
    for (const child of laidOut.children ?? []) {
      const orig = nodeById.get(child.id);
      const seedBox = seed.positions.get(child.id);
      if (!orig || !seedBox) continue;
      positions.set(child.id, {
        x: Math.round(child.x ?? seedBox.x),
        y: Math.round(child.y ?? seedBox.y),
        width: seedBox.width,
        height: seedBox.height,
        angle: seedBox.angle,
      });
    }

    for (const node of visibleNodes) {
      if (!positions.has(node.id)) {
        positions.set(node.id, seed.positions.get(node.id)!);
      }
    }

    resolveBoxOverlaps(positions, centerNode.id, 'orbital', 24);
    const bounds = measureStageBounds(positions);
    return {
      positions,
      width: bounds.width,
      height: bounds.height,
      visibleNodes,
      mode,
    };
  } catch {
    return seed;
  }
}
