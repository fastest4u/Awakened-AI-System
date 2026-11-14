import { useState, useEffect, useMemo, useRef } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { graphQuery } from '@/api/queries';
import { useProjectRoot } from '@/hooks/use-project-root';
import { useOpenNote } from '@/hooks/use-open-note';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  computeNeighborhood,
  filterGraph,
  computeFlowLayout,
  computeOrbitalLayout,
  pickSpotlightLabels,
  findMatchingNode,
} from '@/lib/graph-layout';
import type { GraphNode } from '@/api/types';
import { usePanZoom } from './use-pan-zoom';
import { GraphToolbar } from './graph-toolbar';
import { GraphZoomHud } from './graph-zoom-hud';
import { GraphCanvas } from './graph-canvas';
import { GraphInspector, type GraphStory } from './graph-inspector';

export function GraphPage() {
  const projectRoot = useProjectRoot();
  const openNote = useOpenNote();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | undefined>;

  const [layoutMode, setLayoutMode] = useState<'flow' | 'orbital'>('flow');

  // Search input state with debouncing and safe external URL sync guard
  const urlQ = search?.q || '';
  const [searchQuery, setSearchQuery] = useState(urlQ);
  const debouncedSearch = useDebouncedValue(searchQuery, 250);
  const lastSyncedUrlQ = useRef(urlQ);
  const isUserTypingRef = useRef(false);

  // Sync external URL `q` changes into local state
  useEffect(() => {
    if (urlQ !== lastSyncedUrlQ.current) {
      lastSyncedUrlQ.current = urlQ;
      isUserTypingRef.current = false;
      setSearchQuery(urlQ);
    }
  }, [urlQ]);

  // Sync debounced search input to URL `q` parameter only when user typed
  useEffect(() => {
    if (!isUserTypingRef.current) return;
    const nextQ = debouncedSearch.trim();
    const currentQ = (search?.q || '').trim();
    if (currentQ !== nextQ) {
      lastSyncedUrlQ.current = nextQ;
      isUserTypingRef.current = false;
      navigate({
        to: '.',
        search: (prev: any) => {
          const next = { ...prev };
          if (nextQ) {
            next.q = nextQ;
          } else {
            delete next.q;
          }
          return next;
        },
        replace: true,
      });
    }
  }, [debouncedSearch, navigate, search?.q]);

  const handleSearchChange = (val: string) => {
    isUserTypingRef.current = true;
    setSearchQuery(val);
  };

  const handleKindChange = (kind: string) => {
    navigate({
      to: '.',
      search: (prev: any) => {
        const next = { ...prev };
        if (kind && kind !== 'all') {
          next.kind = kind;
        } else {
          delete next.kind;
        }
        return next;
      },
      replace: true,
    });
  };

  const handleSessionChange = (sessionVal: string) => {
    navigate({
      to: '.',
      search: (prev: any) => {
        const next = { ...prev };
        if (sessionVal && sessionVal !== 'all') {
          next.session = sessionVal;
        } else {
          delete next.session;
        }
        return next;
      },
      replace: true,
    });
  };

  const handleSelectNode = (nodeId: string) => {
    navigate({
      to: '.',
      search: (prev: any) => {
        const next = { ...prev };
        if (nodeId) {
          next.node = nodeId;
        } else {
          delete next.node;
        }
        return next;
      },
      replace: true,
    });
  };

  const handleOpenInKanban = (label: string) => {
    navigate({
      to: '/kanban',
      search: (prev: any) => ({
        project: prev.project,
        q: label,
      }),
    });
  };

  const handleToggleSessionFilter = (sessionId: string) => {
    const currentSession = search?.session;
    const rawCurrent = currentSession ? currentSession.replace(/^session:/, '') : '';
    const rawTarget = sessionId.replace(/^session:/, '');
    const isCurrentlyActive = rawCurrent === rawTarget || currentSession === sessionId;
    handleSessionChange(isCurrentlyActive ? 'all' : sessionId);
  };

  const { data: graphData, isLoading } = useQuery(graphQuery(projectRoot));

  const rawNodes = useMemo(() => graphData?.nodes || [], [graphData?.nodes]);
  const rawEdges = useMemo(() => graphData?.edges || [], [graphData?.edges]);
  const sessionNodesList = useMemo(
    () => rawNodes.filter((n) => n.kind === 'session'),
    [rawNodes],
  );

  const effectiveQuery = isUserTypingRef.current
    ? debouncedSearch.trim()
    : (urlQ || debouncedSearch).trim();

  const kindFilter = (search?.kind as any) || 'all';
  const sessionFilter = search?.session || 'all';

  // Filtered graph
  const filtered = useMemo(() => {
    if (!graphData) return { nodes: [], edges: [] };
    return filterGraph(graphData, {
      q: effectiveQuery,
      kind: kindFilter,
      session: sessionFilter,
    });
  }, [graphData, effectiveQuery, kindFilter, sessionFilter]);

  // Node resolution for selected node
  const selectedNode = useMemo(() => {
    if (filtered.nodes.length === 0 && rawNodes.length === 0) return null;
    const target = search?.node;
    if (target) {
      const match =
        findMatchingNode(filtered.nodes, target) ||
        findMatchingNode(rawNodes, target);
      if (match) return match;
    }
    // Default fallback
    return (
      filtered.nodes.find((n) => n.kind === 'note') ||
      filtered.nodes.find((n) => n.kind === 'session') ||
      filtered.nodes[0] ||
      null
    );
  }, [filtered.nodes, rawNodes, search?.node]);

  // Neighborhood around selected node
  const highlightedNodeIds = useMemo(() => {
    return computeNeighborhood(selectedNode?.id, rawEdges, rawNodes);
  }, [selectedNode?.id, rawEdges, rawNodes]);

  // Layout computation
  const layoutResult = useMemo(() => {
    if (layoutMode === 'flow') {
      return computeFlowLayout(filtered.nodes, highlightedNodeIds);
    }
    return computeOrbitalLayout(
      filtered.nodes,
      highlightedNodeIds,
      selectedNode?.id,
    );
  }, [layoutMode, filtered.nodes, highlightedNodeIds, selectedNode?.id]);

  // Spotlight labels in orbital mode
  const spotlightLabelIds = useMemo(() => {
    return pickSpotlightLabels(
      filtered.nodes,
      layoutResult.positions,
      selectedNode?.id,
      highlightedNodeIds,
    );
  }, [filtered.nodes, layoutResult.positions, selectedNode?.id, highlightedNodeIds]);

  // Pan / Zoom hook
  const {
    zoom,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    wasDraggingRef,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    viewBox,
  } = usePanZoom({
    width: layoutResult.width,
    height: layoutResult.height,
  });

  const handleFocusSelected = () => {
    if (!selectedNode) return;
    const pos = layoutResult.positions.get(selectedNode.id);
    if (pos) {
      focusNode(pos);
    }
  };

  const handleFocusNode = (nodeId: string) => {
    const pos = layoutResult.positions.get(nodeId);
    if (pos) {
      focusNode(pos);
    }
  };

  // Human-readable story relationships for inspector
  const story: GraphStory = useMemo(() => {
    const nodeById = new Map<string, GraphNode>(
      rawNodes.map((n) => [n.id, n]),
    );
    const relatedSessions: GraphNode[] = [];
    const relatedNotes: GraphNode[] = [];
    const relatedFiles: GraphNode[] = [];
    const relatedSymbols: GraphNode[] = [];

    for (const hid of highlightedNodeIds) {
      if (selectedNode && hid === selectedNode.id) continue;
      const item = nodeById.get(hid);
      if (!item) continue;
      if (item.kind === 'session') relatedSessions.push(item);
      else if (item.kind === 'note') relatedNotes.push(item);
      else if (item.kind === 'file') relatedFiles.push(item);
      else if (item.kind === 'symbol') relatedSymbols.push(item);
    }

    return {
      relatedSessions,
      relatedNotes,
      relatedFiles,
      relatedSymbols,
    };
  }, [rawNodes, highlightedNodeIds, selectedNode]);

  if (isLoading && !graphData) {
    return (
      <div className="space-y-6 p-6">
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-[520px] w-full rounded-xl" />
      </div>
    );
  }

  const rawStats = graphData?.stats || {
    sessionNodes: sessionNodesList.length,
    noteNodes: rawNodes.filter((n) => n.kind === 'note').length,
    fileNodes: rawNodes.filter((n) => n.kind === 'file').length,
    symbolNodes: rawNodes.filter((n) => n.kind === 'symbol').length,
    edgeCount: rawEdges.length,
  };

  const hiddenCount = Math.max(
    0,
    filtered.nodes.length - layoutResult.visibleNodes.length,
  );

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      <Card>
        <GraphToolbar
          layoutMode={layoutMode}
          onLayoutModeChange={setLayoutMode}
          searchQuery={searchQuery}
          onSearchChange={handleSearchChange}
          sessionFilter={sessionFilter}
          onSessionChange={handleSessionChange}
          sessionNodesList={sessionNodesList}
          kindFilter={kindFilter}
          onKindChange={handleKindChange}
          totalFilteredCount={filtered.nodes.length}
          stats={rawStats}
        />

        <CardContent className="pt-2">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-4 items-start">
            {/* Left Pane: Canvas + Zoom HUD */}
            <div className="min-w-0">
              <GraphZoomHud
                nodeCount={layoutResult.visibleNodes.length}
                hiddenCount={hiddenCount}
                zoom={zoom}
                onZoomIn={zoomIn}
                onZoomOut={zoomOut}
                onResetZoom={resetZoom}
                onFocusSelected={handleFocusSelected}
              />

              <GraphCanvas
                layoutMode={layoutMode}
                width={layoutResult.width}
                height={layoutResult.height}
                viewBox={viewBox}
                nodes={layoutResult.visibleNodes}
                edges={filtered.edges}
                positions={layoutResult.positions}
                selectedNodeId={selectedNode?.id || null}
                highlightedNodeIds={highlightedNodeIds}
                spotlightLabelIds={spotlightLabelIds}
                onSelectNode={handleSelectNode}
                onFocusNode={handleFocusNode}
                onOpenNote={openNote}
                onWheel={handleWheel}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
                wasDraggingRef={wasDraggingRef}
              />
            </div>

            {/* Right Pane: Story Inspector */}
            <div className="min-w-0">
              <GraphInspector
                selectedNode={selectedNode}
                story={story}
                sessionFilter={sessionFilter}
                onSelectNode={handleSelectNode}
                onOpenNote={openNote}
                onOpenInKanban={handleOpenInKanban}
                onToggleSessionFilter={handleToggleSessionFilter}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
