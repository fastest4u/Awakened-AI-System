import '@xyflow/react/dist/style.css';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeChange,
} from '@xyflow/react';
import type { GraphEdge, GraphNode } from '@/api/types';
import {
  buildSeedLayout,
  CARD_DIMENSIONS,
  computeElkGraphLayout,
  type ElkLayoutPosition,
} from '@/lib/elk-graph-layout';
import {
  graphEdgeTypes,
  type SemanticFlowEdge,
} from './graph-edges';
import {
  graphNodeTypes,
  type GraphFlowNode,
} from './graph-nodes';

export interface GraphCanvasHandle {
  zoomTo: (zoomLevel: number) => void;
  focusNode: (nodeId: string, zoomLevel?: number) => void;
  fitView: () => void;
  resetView: () => void;
}

export interface GraphCanvasProps {
  layoutMode: 'flow' | 'orbital';
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds: ReadonlySet<string>;
  onSelectNode: (id: string) => void;
  onFocusNode: (id: string) => void;
  onOpenNote: (recordId: string) => void;
  onSyncZoom?: (zoom: number) => void;
}

const KIND_RANK: Record<GraphNode['kind'], number> = {
  session: 0,
  note: 1,
  file: 2,
  symbol: 3,
};

const NODE_TYPE_MAP: Record<GraphNode['kind'], GraphFlowNode['type']> = {
  session: 'sessionCard',
  note: 'noteCard',
  file: 'fileCard',
  symbol: 'symbolCard',
};

const FLOW_COLUMN_GUIDES = [
  {
    step: '1. เซสชัน AI',
    title: 'จุดเริ่มต้นของงาน',
    dotHex: '#0ea5e9',
    badgeClass: 'border-[#0ea5e9]/35 bg-[#0ea5e9]/10 text-[#38bdf8]',
  },
  {
    step: '2. ความจำ & กฎ',
    title: 'การตัดสินใจ & บทเรียน',
    dotHex: '#a855f7',
    badgeClass: 'border-[#a855f7]/35 bg-[#a855f7]/10 text-[#c084fc]',
  },
  {
    step: '3. ไฟล์โค้ด',
    title: 'ซอร์สโค้ดที่เกี่ยวข้อง',
    dotHex: '#10b981',
    badgeClass: 'border-[#10b981]/35 bg-[#10b981]/10 text-[#34d399]',
  },
  {
    step: '4. ฟังก์ชัน / คลาส',
    title: 'โมดูลที่ได้รับผลกระทบ',
    dotHex: '#f59e0b',
    badgeClass: 'border-[#f59e0b]/35 bg-[#f59e0b]/10 text-[#fbbf24]',
  },
] as const;

function buildFlowNodesFromPositions(
  visibleNodes: readonly GraphNode[],
  positions: ReadonlyMap<string, ElkLayoutPosition>,
  selectedNodeId: string | null,
  highlightedNodeIds: ReadonlySet<string>,
  onOpenNote: (recordId: string) => void,
): GraphFlowNode[] {
  return visibleNodes.map((node) => {
    const dim = CARD_DIMENSIONS[node.kind];
    const pos = positions.get(node.id) ?? {
      x: 48,
      y: 96,
      width: dim.width,
      height: dim.height,
    };
    const isSelected = node.id === selectedNodeId;
    const isHighlighted = isSelected || highlightedNodeIds.has(node.id);

    return {
      id: node.id,
      type: NODE_TYPE_MAP[node.kind],
      position: { x: pos.x, y: pos.y },
      width: pos.width,
      height: pos.height,
      initialWidth: pos.width,
      initialHeight: pos.height,
      measured: { width: pos.width, height: pos.height },
      selected: isSelected,
      draggable: true,
      selectable: true,
      data: {
        node,
        isSelected,
        isHighlighted,
        onOpenNote,
      },
    } as GraphFlowNode;
  });
}

function resolveEdgeHandles(
  edge: GraphEdge,
  srcNode: GraphNode,
  tgtNode: GraphNode,
  positions: ReadonlyMap<string, ElkLayoutPosition>,
  mode: 'flow' | 'orbital',
): { sourceHandle: string; targetHandle: string } {
  const srcPos = positions.get(edge.source);
  const tgtPos = positions.get(edge.target);

  if (mode === 'flow') {
    const srcRank = KIND_RANK[srcNode.kind];
    const tgtRank = KIND_RANK[tgtNode.kind];
    if (srcRank < tgtRank) {
      return { sourceHandle: 'out-right', targetHandle: 'in-left' };
    }
    if (srcRank > tgtRank) {
      return { sourceHandle: 'out-left', targetHandle: 'in-right' };
    }
    if (srcPos && tgtPos && Math.abs(srcPos.y - tgtPos.y) <= srcPos.height + 44) {
      return srcPos.y <= tgtPos.y
        ? { sourceHandle: 'out-bottom', targetHandle: 'in-top' }
        : { sourceHandle: 'out-top', targetHandle: 'in-bottom' };
    }
    return { sourceHandle: 'out-right', targetHandle: 'in-right' };
  }

  if (srcPos && tgtPos) {
    const srcMidX = srcPos.x + srcPos.width / 2;
    const srcMidY = srcPos.y + srcPos.height / 2;
    const tgtMidX = tgtPos.x + tgtPos.width / 2;
    const tgtMidY = tgtPos.y + tgtPos.height / 2;
    const dx = tgtMidX - srcMidX;
    const dy = tgtMidY - srcMidY;

    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx >= 0
        ? { sourceHandle: 'out-right', targetHandle: 'in-left' }
        : { sourceHandle: 'out-left', targetHandle: 'in-right' };
    }
    return dy >= 0
      ? { sourceHandle: 'out-bottom', targetHandle: 'in-top' }
      : { sourceHandle: 'out-top', targetHandle: 'in-bottom' };
  }

  return { sourceHandle: 'out-right', targetHandle: 'in-left' };
}

const GraphCanvasInner = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvasInner(
    {
      layoutMode,
      nodes,
      edges,
      selectedNodeId,
      highlightedNodeIds,
      onSelectNode,
      onFocusNode,
      onOpenNote,
      onSyncZoom,
    },
    ref,
  ) {
    const reactFlow = useReactFlow<GraphFlowNode, SemanticFlowEdge>();
    const onOpenNoteRef = useRef(onOpenNote);
    onOpenNoteRef.current = onOpenNote;

    const stableOpenNote = useCallback((recordId: string) => {
      onOpenNoteRef.current(recordId);
    }, []);

    // Seed synchronously so frame 0 renders glassmorphic cards with zero flicker
    const seedLayout = useMemo(
      () =>
        buildSeedLayout(
          nodes,
          edges,
          layoutMode,
          selectedNodeId,
          highlightedNodeIds,
        ),
      [nodes, edges, layoutMode, selectedNodeId, highlightedNodeIds],
    );

    const [activePositions, setActivePositions] = useState<
      Map<string, ElkLayoutPosition>
    >(() => seedLayout.positions);

    const [rfNodes, setRfNodes] = useState<GraphFlowNode[]>(() =>
      buildFlowNodesFromPositions(
        seedLayout.visibleNodes,
        seedLayout.positions,
        selectedNodeId,
        highlightedNodeIds,
        stableOpenNote,
      ),
    );

    const lastTopologyKeyRef = useRef<string>('');
    const elkRunIdRef = useRef(0);
    const lastClickRef = useRef<{ id: string; ts: number } | null>(null);
    const lastDoubleTriggerRef = useRef<{ id: string; ts: number } | null>(null);
    const programmaticMoveUntilRef = useRef(0);

    const runProgrammaticCamera = useCallback((fn: () => void) => {
      programmaticMoveUntilRef.current = Date.now() + 600;
      try {
        fn();
      } catch {
        // Ignore transient camera errors in non-layout test containers
      }
    }, []);

    const topologyKey = useMemo(() => {
      const nodeIdsKey = seedLayout.visibleNodes.map((n) => n.id).join('|');
      const edgeKey = edges.map((e) => `${e.source}->${e.target}:${e.relation}`).join('|');
      const centerKey = layoutMode === 'orbital' ? selectedNodeId || '' : '';
      return `${layoutMode}::${centerKey}::${nodeIdsKey}::${edgeKey}`;
    }, [layoutMode, selectedNodeId, seedLayout.visibleNodes, edges]);

    // Apply synchronous seed and launch async ELK refinement when graph topology changes
    useEffect(() => {
      const topologyChanged = lastTopologyKeyRef.current !== topologyKey;
      if (!topologyChanged) {
        // Only update visual selection/highlight state without disturbing card positions
        setRfNodes((prev) =>
          prev.map((rfNode) => {
            const graphNode = rfNode.data.node;
            const isSelected = graphNode.id === selectedNodeId;
            const isHighlighted =
              isSelected || highlightedNodeIds.has(graphNode.id);
            return {
              ...rfNode,
              selected: isSelected,
              data: {
                node: graphNode,
                isSelected,
                isHighlighted,
                onOpenNote: stableOpenNote,
              },
            };
          }),
        );
        return;
      }

      lastTopologyKeyRef.current = topologyKey;
      setActivePositions(seedLayout.positions);
      setRfNodes(
        buildFlowNodesFromPositions(
          seedLayout.visibleNodes,
          seedLayout.positions,
          selectedNodeId,
          highlightedNodeIds,
          stableOpenNote,
        ),
      );

      const runId = ++elkRunIdRef.current;
      let cancelled = false;

      void computeElkGraphLayout(
        nodes,
        edges,
        layoutMode,
        selectedNodeId,
        highlightedNodeIds,
      ).then((elkResult) => {
        if (cancelled || elkRunIdRef.current !== runId) return;
        setActivePositions(elkResult.positions);
        setRfNodes((prev) => {
          const prevPosById = new Map(prev.map((n) => [n.id, n.position]));
          return buildFlowNodesFromPositions(
            elkResult.visibleNodes,
            elkResult.positions,
            selectedNodeId,
            highlightedNodeIds,
            stableOpenNote,
          ).map((nextNode) => ({
            ...nextNode,
            position:
              elkResult.positions.get(nextNode.id)
                ? {
                    x: elkResult.positions.get(nextNode.id)!.x,
                    y: elkResult.positions.get(nextNode.id)!.y,
                  }
                : prevPosById.get(nextNode.id) ?? nextNode.position,
          }));
        });
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (cancelled || elkRunIdRef.current !== runId) return;
            runProgrammaticCamera(() => {
              void reactFlow.fitView({
                padding: 0.14,
                maxZoom: 1,
                duration: 280,
              });
            });
          });
        }
      });

      return () => {
        cancelled = true;
      };
    }, [
      topologyKey,
      seedLayout,
      nodes,
      edges,
      layoutMode,
      selectedNodeId,
      highlightedNodeIds,
      stableOpenNote,
      reactFlow,
      runProgrammaticCamera,
    ]);

    const positionMapForEdges = useMemo(() => {
      const merged = new Map<string, ElkLayoutPosition>(activePositions);
      for (const rfNode of rfNodes) {
        const dim = CARD_DIMENSIONS[rfNode.data.node.kind];
        merged.set(rfNode.id, {
          x: rfNode.position.x,
          y: rfNode.position.y,
          width: rfNode.width ?? dim.width,
          height: rfNode.height ?? dim.height,
        });
      }
      return merged;
    }, [activePositions, rfNodes]);

    const rfEdges = useMemo<SemanticFlowEdge[]>(() => {
      const nodeById = new Map<string, GraphNode>();
      for (const rfNode of rfNodes) {
        nodeById.set(rfNode.id, rfNode.data.node);
      }

      const list: SemanticFlowEdge[] = [];
      const seen = new Set<string>();

      for (let i = 0; i < edges.length; i++) {
        const edge = edges[i];
        if (edge.source === edge.target) continue;
        const srcNode = nodeById.get(edge.source);
        const tgtNode = nodeById.get(edge.target);
        if (!srcNode || !tgtNode) continue;

        const key = `${edge.source}::${edge.target}::${edge.relation}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const { sourceHandle, targetHandle } = resolveEdgeHandles(
          edge,
          srcNode,
          tgtNode,
          positionMapForEdges,
          layoutMode,
        );

        const incidentSelected =
          edge.source === selectedNodeId || edge.target === selectedNodeId;
        const highlighted =
          incidentSelected ||
          (highlightedNodeIds.has(edge.source) &&
            highlightedNodeIds.has(edge.target));

        list.push({
          id: `edge-${i}-${key}`,
          type: 'semantic',
          source: edge.source,
          target: edge.target,
          sourceHandle,
          targetHandle,
          zIndex: incidentSelected ? 20 : highlighted ? 10 : 1,
          data: {
            relation: edge.relation,
            highlighted,
            incidentSelected,
          },
        });
      }

      return list;
    }, [edges, rfNodes, positionMapForEdges, layoutMode, selectedNodeId, highlightedNodeIds]);

    useImperativeHandle(
      ref,
      () => ({
        zoomTo: (zoomLevel: number) => {
          runProgrammaticCamera(() => {
            void reactFlow.zoomTo(zoomLevel, { duration: 220 });
          });
        },
        focusNode: (nodeId: string, zoomLevel = 1.75) => {
          const target = rfNodes.find((n) => n.id === nodeId);
          if (!target) return;
          const dim = CARD_DIMENSIONS[target.data.node.kind];
          runProgrammaticCamera(() => {
            void reactFlow.setCenter(
              target.position.x + (target.width ?? dim.width) / 2,
              target.position.y + (target.height ?? dim.height) / 2,
              { zoom: zoomLevel, duration: 320 },
            );
          });
        },
        fitView: () => {
          runProgrammaticCamera(() => {
            void reactFlow.fitView({ padding: 0.14, maxZoom: 1, duration: 280 });
          });
        },
        resetView: () => {
          runProgrammaticCamera(() => {
            void reactFlow.fitView({
              padding: 0.14,
              minZoom: 1,
              maxZoom: 1,
              duration: 260,
            });
          });
        },
      }),
      [reactFlow, rfNodes, runProgrammaticCamera],
    );

    const handleNodesChange = useCallback(
      (changes: NodeChange<GraphFlowNode>[]) => {
        setRfNodes((nds) => applyNodeChanges(changes, nds));
      },
      [],
    );

    const triggerOpenOrFocus = useCallback(
      (rfNode: GraphFlowNode) => {
        const now = Date.now();
        if (
          lastDoubleTriggerRef.current &&
          lastDoubleTriggerRef.current.id === rfNode.id &&
          now - lastDoubleTriggerRef.current.ts < 450
        ) {
          return;
        }
        lastDoubleTriggerRef.current = { id: rfNode.id, ts: now };

        onFocusNode(rfNode.id);
        const graphNode = rfNode.data.node;
        if (graphNode.kind === 'note' && graphNode.recordId) {
          onOpenNote(graphNode.recordId);
        }
      },
      [onFocusNode, onOpenNote],
    );

    const handleNodeClick = useCallback(
      (_event: React.MouseEvent, rfNode: GraphFlowNode) => {
        const now = Date.now();
        const prev = lastClickRef.current;
        if (prev && prev.id === rfNode.id && now - prev.ts < 400) {
          lastClickRef.current = null;
          triggerOpenOrFocus(rfNode);
          return;
        }
        lastClickRef.current = { id: rfNode.id, ts: now };
        onSelectNode(rfNode.id);
      },
      [onSelectNode, triggerOpenOrFocus],
    );

    const handleNodeDoubleClick = useCallback(
      (_event: React.MouseEvent, rfNode: GraphFlowNode) => {
        lastClickRef.current = null;
        triggerOpenOrFocus(rfNode);
      },
      [triggerOpenOrFocus],
    );

    const minimapNodeColor = useCallback((node: GraphFlowNode) => {
      switch (node.type) {
        case 'sessionCard':
          return '#0ea5e9';
        case 'noteCard':
          return '#a855f7';
        case 'fileCard':
          return '#10b981';
        case 'symbolCard':
          return '#f59e0b';
        default:
          return '#6366f1';
      }
    }, []);

    return (
      <div className="relative h-[620px] w-full overflow-hidden rounded-xl border border-border/80 bg-background/90">
        {layoutMode === 'flow' ? (
          <div
            id="flow-column-guides"
            className="pointer-events-none absolute top-2.5 left-3 right-3 z-10 grid grid-cols-4 gap-2"
          >
            {FLOW_COLUMN_GUIDES.map((col) => (
              <div
                key={col.title}
                className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11px] backdrop-blur-md shadow-sm ${col.badgeClass}`}
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: col.dotHex }}
                />
                <div className="min-w-0 leading-tight">
                  <div className="truncate font-semibold">{col.title}</div>
                  <div className="truncate text-[9px] opacity-80">{col.step}</div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="pointer-events-none absolute top-2.5 left-3 z-10 inline-flex items-center gap-2 rounded-lg border border-[#a855f7]/35 bg-card/85 px-3 py-1.5 text-[11px] font-medium text-foreground backdrop-blur-md shadow-sm">
            <span className="size-2 rounded-full bg-[#a855f7]" />
            <span>เครือข่ายวงโคจร (ELK Galaxy)</span>
            <span className="text-muted-foreground hidden sm:inline">
              • ลากการ์ดหรือดับเบิลคลิกเพื่อสลับจุดศูนย์กลาง
            </span>
          </div>
        )}

        <ReactFlow<GraphFlowNode, SemanticFlowEdge>
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={graphNodeTypes}
          edgeTypes={graphEdgeTypes}
          onNodesChange={handleNodesChange}
          onNodeClick={handleNodeClick}
          onNodeDoubleClick={handleNodeDoubleClick}
          onMoveEnd={(event, viewport) => {
            // Only sync zoom back from real user pan/wheel gestures so programmatic
            // HUD buttons keep synchronous, exact readouts
            if (event && Date.now() >= programmaticMoveUntilRef.current) {
              onSyncZoom?.(viewport.zoom);
            }
          }}
          defaultViewport={{ x: 24, y: 20, zoom: 1 }}
          minZoom={0.25}
          maxZoom={2.5}
          nodesConnectable={false}
          edgesFocusable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={1.25}
            color="#64748b"
            className="opacity-30"
          />
          <MiniMap<GraphFlowNode>
            nodeColor={minimapNodeColor}
            nodeStrokeWidth={2}
            maskColor="rgba(15, 23, 42, 0.35)"
            pannable
            zoomable
            className="!bottom-3 !right-3"
          />
        </ReactFlow>
      </div>
    );
  },
);

export const GraphCanvas = forwardRef<GraphCanvasHandle, GraphCanvasProps>(
  function GraphCanvas(props, ref) {
    return (
      <div
        id="knowledge-graph-canvas"
        data-layout-mode={props.layoutMode}
        className="xyflow-graph-stage relative w-full select-none"
      >
        <ReactFlowProvider initialWidth={960} initialHeight={620}>
          <GraphCanvasInner ref={ref} {...props} />
        </ReactFlowProvider>
      </div>
    );
  },
);
