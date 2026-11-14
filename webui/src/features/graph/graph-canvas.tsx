import { useRef, useState } from 'react';
import type { GraphNode, GraphEdge } from '@/api/types';
import type { LayoutPosition } from '@/lib/graph-layout';
import {
  shortNodeDisplayLabel,
  fullNodeTooltipLabel,
} from '@/lib/graph-labels';

export interface GraphCanvasProps {
  layoutMode: 'flow' | 'orbital';
  width: number;
  height: number;
  viewBox: string;
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  positions: ReadonlyMap<string, LayoutPosition>;
  selectedNodeId: string | null;
  highlightedNodeIds: ReadonlySet<string>;
  spotlightLabelIds: ReadonlySet<string>;
  onSelectNode: (id: string) => void;
  onFocusNode: (id: string) => void;
  onOpenNote: (recordId: string) => void;
  onWheel: (e: React.WheelEvent) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  onMouseMove: (e: React.MouseEvent) => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
  wasDraggingRef: React.RefObject<boolean>;
}

export function GraphCanvas({
  layoutMode,
  width,
  height,
  viewBox,
  nodes,
  edges,
  positions,
  selectedNodeId,
  highlightedNodeIds,
  spotlightLabelIds,
  onSelectNode,
  onFocusNode,
  onOpenNote,
  onWheel,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onMouseLeave,
  wasDraggingRef,
}: GraphCanvasProps) {
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const lastClickRef = useRef<{ id: string; ts: number } | null>(null);

  const columnHeaders = [
    { x: 122, title: '1. ภารกิจ AI (Session)', sub: 'จุดเริ่มต้นของงาน', color: '#38bdf8' },
    { x: 368, title: '2. ความจำที่ได้ (Memory)', sub: 'การตัดสินใจ & บทเรียน', color: '#6366f1' },
    { x: 628, title: '3. ไฟล์ที่แก้ไข (File)', sub: 'ซอร์สโค้ดที่เกี่ยวข้อง', color: '#10b981' },
    { x: 852, title: '4. ฟังก์ชัน/คลาส (Symbol)', sub: 'โมดูลที่ได้รับผลกระทบ', color: '#f59e0b' },
  ];

  const handleNodeClick = (node: GraphNode) => {
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    const now = Date.now();
    const isDouble =
      lastClickRef.current &&
      lastClickRef.current.id === node.id &&
      now - lastClickRef.current.ts < 400;

    lastClickRef.current = { id: node.id, ts: isDouble ? 0 : now };
    onSelectNode(node.id);

    if (isDouble) {
      onFocusNode(node.id);
      if (node.kind === 'note') {
        const recId = node.recordId || node.id.replace(/^note:/, '');
        onOpenNote(recId);
      }
    }
  };

  const handleNodeDoubleClick = (node: GraphNode) => {
    onFocusNode(node.id);
    if (node.kind === 'note') {
      const recId = node.recordId || node.id.replace(/^note:/, '');
      onOpenNote(recId);
    }
  };

  const cx = width / 2;
  const cy = height / 2;

  // Sort nodes so highlighted and selected are drawn on top
  const sortedNodes = [...nodes].sort((a, b) => {
    const aScore = a.id === selectedNodeId ? 2 : highlightedNodeIds.has(a.id) ? 1 : 0;
    const bScore = b.id === selectedNodeId ? 2 : highlightedNodeIds.has(b.id) ? 1 : 0;
    return aScore - bScore;
  });

  // Sort edges so highlighted are drawn on top
  const sortedEdges = [...edges].sort((a, b) => {
    const aHi = highlightedNodeIds.has(a.source) && highlightedNodeIds.has(a.target) ? 1 : 0;
    const bHi = highlightedNodeIds.has(b.source) && highlightedNodeIds.has(b.target) ? 1 : 0;
    return aHi - bHi;
  });

  return (
    <div className="flex flex-col min-w-0">
      <svg
        id="knowledge-graph-canvas"
        viewBox={viewBox}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        className="w-full select-none cursor-grab active:cursor-grabbing rounded-xl border border-border bg-background transition-colors"
        style={{
          height: layoutMode === 'flow' ? '540px' : '520px',
        }}
      >
        {/* Flow Mode Column Headers & Guide Lanes */}
        {layoutMode === 'flow' ? (
          <g id="flow-column-guides">
            {columnHeaders.map((col, idx) => (
              <g key={`col-hdr-${idx}`}>
                <rect
                  x={col.x - 102}
                  y={10}
                  width={204}
                  height={38}
                  rx={8}
                  fill="var(--card)"
                  stroke={col.color}
                  strokeOpacity="0.4"
                />
                <text
                  x={col.x}
                  y={26}
                  fill={col.color}
                  fontSize="11.5"
                  fontWeight="700"
                  textAnchor="middle"
                >
                  {col.title}
                </text>
                <text
                  x={col.x}
                  y={40}
                  fill="var(--muted-foreground)"
                  fontSize="9.5"
                  textAnchor="middle"
                >
                  {col.sub}
                </text>
                <line
                  x1={col.x}
                  y1={52}
                  x2={col.x}
                  y2={height - 14}
                  stroke="var(--border)"
                  strokeDasharray="3 5"
                  opacity="0.35"
                />
              </g>
            ))}
          </g>
        ) : (
          <g id="orbital-guide-rings">
            {[90, 170, 235].map((r, idx) => (
              <circle
                key={`orbit-${idx}`}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke="var(--border)"
                strokeDasharray="4 6"
                opacity="0.35"
              />
            ))}
          </g>
        )}

        {/* Edges */}
        <g id="graph-edges">
          {sortedEdges.map((e, i) => {
            const s = positions.get(e.source);
            const t = positions.get(e.target);
            if (!s || !t) return null;

            const isHi =
              highlightedNodeIds.has(e.source) &&
              highlightedNodeIds.has(e.target);
            const isDirect =
              selectedNodeId === e.source || selectedNodeId === e.target;

            const strokeColor =
              e.relation === 'created-in-session' || e.relation === 'forked-from'
                ? '#38bdf8'
                : e.relation === 'touches-file'
                  ? '#10b981'
                  : e.relation === 'supersedes'
                    ? '#a855f7'
                    : e.relation === 'causal-triad'
                      ? '#ef4444'
                      : e.relation === 'links-to-note'
                        ? '#ec4899'
                        : '#f59e0b';

            if (layoutMode === 'flow') {
              const sx = s.x + (s.x < t.x ? 96 : -96);
              const sy = s.y;
              const tx = t.x + (s.x < t.x ? -96 : 96);
              const ty = t.y;
              const c1x = Math.round(sx + (tx - sx) * 0.45);
              const c2x = Math.round(sx + (tx - sx) * 0.55);
              const dFlow = `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${ty}, ${tx} ${ty}`;

              if (isHi) {
                return (
                  <g key={`edge-hi-${i}`}>
                    <path
                      d={dFlow}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={isDirect ? '6.5' : '4.5'}
                      opacity={isDirect ? 0.24 : 0.14}
                    />
                    <path
                      d={dFlow}
                      fill="none"
                      stroke={strokeColor}
                      strokeWidth={isDirect ? '3' : '2.2'}
                      opacity={0.98}
                    />
                    <path
                      d={dFlow}
                      fill="none"
                      stroke="var(--foreground)"
                      strokeWidth="1.2"
                      strokeDasharray="5 7"
                      opacity={isDirect ? 0.55 : 0.35}
                    />
                  </g>
                );
              }

              return (
                <path
                  key={`edge-${i}`}
                  d={dFlow}
                  fill="none"
                  stroke="var(--border)"
                  strokeWidth="1"
                  opacity={0.12}
                />
              );
            }

            // Orbital Mode quadratic curve
            const mx = Math.round((s.x + t.x) / 2);
            const my = Math.round((s.y + t.y) / 2 - 18);
            const dOrb = `M ${s.x} ${s.y} Q ${mx} ${my} ${t.x} ${t.y}`;

            if (isHi) {
              return (
                <g key={`edge-orb-hi-${i}`}>
                  <path
                    d={dOrb}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={isDirect ? '6.5' : '4.5'}
                    opacity={isDirect ? 0.26 : 0.15}
                  />
                  <path
                    d={dOrb}
                    fill="none"
                    stroke={strokeColor}
                    strokeWidth={isDirect ? '3' : '2.2'}
                    opacity={0.98}
                  />
                  <path
                    d={dOrb}
                    fill="none"
                    stroke="var(--foreground)"
                    strokeWidth="1.2"
                    strokeDasharray="5 7"
                    opacity={isDirect ? 0.55 : 0.35}
                  />
                </g>
              );
            }

            return (
              <path
                key={`edge-${i}`}
                d={dOrb}
                fill="none"
                stroke="var(--border)"
                strokeWidth="1"
                opacity={0.08}
              />
            );
          })}
        </g>

        {/* Nodes */}
        <g id="graph-nodes">
          {sortedNodes.map((n) => {
            const p = positions.get(n.id);
            if (!p) return null;

            const color =
              n.kind === 'session'
                ? '#38bdf8'
                : n.kind === 'note'
                  ? n.subkind === 'adr'
                    ? '#6366f1'
                    : n.subkind === 'mistake'
                      ? '#ef4444'
                      : '#10b981'
                  : n.kind === 'file'
                    ? '#10b981'
                    : '#f59e0b';

            const isSelected = selectedNodeId === n.id;
            const isHi = highlightedNodeIds.has(n.id);
            const isHovered = hoveredNodeId === n.id;
            const shortText = shortNodeDisplayLabel(n);
            const tooltipText = fullNodeTooltipLabel(n);

            if (layoutMode === 'flow') {
              const boxW = 200;
              const boxH = 31;
              return (
                <g
                  key={n.id}
                  data-node-id={n.id}
                  data-highlighted={String(isHi)}
                  style={{ cursor: 'pointer' }}
                  opacity={isHi ? 1 : 0.34}
                  onClick={() => handleNodeClick(n)}
                  onDoubleClick={() => handleNodeDoubleClick(n)}
                  onMouseEnter={() => setHoveredNodeId(n.id)}
                  onMouseLeave={() =>
                    setHoveredNodeId((prev) => (prev === n.id ? null : prev))
                  }
                >
                  <title>{tooltipText}</title>

                  {/* Selected Pin */}
                  {isSelected && (
                    <g key="sel-flow-pin">
                      <rect
                        x={p.x - boxW / 2 - 4}
                        y={p.y - boxH / 2 - 4}
                        width={boxW + 8}
                        height={boxH + 8}
                        rx={10}
                        fill="none"
                        stroke="#f43f5e"
                        strokeWidth="2.2"
                        strokeDasharray="4 3"
                      />
                      <rect
                        x={p.x + boxW / 2 - 66}
                        y={p.y - boxH / 2 - 11}
                        width={64}
                        height={15}
                        rx={7}
                        fill="#f43f5e"
                      />
                      <text
                        x={p.x + boxW / 2 - 34}
                        y={p.y - boxH / 2 - 1}
                        fill="#ffffff"
                        fontSize="8.8"
                        fontWeight="700"
                        textAnchor="middle"
                      >
                        ● จุดที่เลือก
                      </text>
                      <rect
                        x={p.x - boxW / 2 - 3}
                        y={p.y - boxH / 2 - 3}
                        width={boxW + 6}
                        height={boxH + 6}
                        rx={10}
                        fill="none"
                        stroke={color}
                        strokeWidth="2"
                        opacity="0.55"
                      />
                    </g>
                  )}

                  {/* Node Rect */}
                  <rect
                    x={p.x - boxW / 2}
                    y={p.y - boxH / 2}
                    width={boxW}
                    height={boxH}
                    rx={8}
                    fill={isSelected ? 'var(--secondary)' : 'var(--card)'}
                    stroke={isSelected || isHi ? color : 'var(--border)'}
                    strokeWidth={isSelected ? 2 : isHi ? 1.4 : 1}
                  />

                  {/* Node Kind Dot */}
                  <circle
                    cx={p.x - boxW / 2 + 13}
                    cy={p.y}
                    r={4.5}
                    fill={color}
                  />

                  {/* Node Label */}
                  <text
                    x={p.x - boxW / 2 + 24}
                    y={p.y + 4}
                    fill="var(--foreground)"
                    fontSize="10.2"
                    fontWeight={isSelected || isHi ? '600' : '500'}
                    textAnchor="start"
                    pointerEvents="none"
                  >
                    {shortText}
                  </text>
                </g>
              );
            }

            // Orbital Mode Node: radiate labels outward from (cx, cy) so labels align with their own node
            const showOrbLabel =
              !isSelected && (spotlightLabelIds.has(n.id) || isHovered);
            const dx = p.x - cx;
            const dy = p.y - cy;
            const dist = Math.hypot(dx, dy);
            const ux = dist > 0 ? dx / dist : 0;
            const uy = dist > 0 ? dy / dist : -1;
            const isPole = dist <= 12 || Math.abs(ux) <= 0.45;
            const radialOffset =
              n.kind === 'session' ? 18 : n.kind === 'note' ? 17 : 15;
            const rawLabelX = isPole ? p.x : p.x + ux * radialOffset;
            const rawLabelY = isPole
              ? uy < 0
                ? p.y - 16
                : p.y + 22
              : p.y + uy * radialOffset + 4;
            const labelX = Math.max(
              16,
              Math.min(width - 16, Math.round(rawLabelX)),
            );
            const labelY = Math.max(
              16,
              Math.min(height - 10, Math.round(rawLabelY)),
            );
            const labelAnchor = isPole ? 'middle' : ux > 0 ? 'start' : 'end';
            const pinBelow = p.y < 50;
            const pinRectY = pinBelow ? p.y + 18 : p.y - 42;
            const pinTextY = pinBelow ? p.y + 32 : p.y - 28;

            return (
              <g
                key={n.id}
                data-node-id={n.id}
                data-highlighted={String(isHi)}
                style={{ cursor: 'pointer' }}
                opacity={isHi || isHovered ? 1 : 0.24}
                onMouseEnter={() => setHoveredNodeId(n.id)}
                onMouseLeave={() =>
                  setHoveredNodeId((prev) => (prev === n.id ? null : prev))
                }
                onClick={() => handleNodeClick(n)}
                onDoubleClick={() => handleNodeDoubleClick(n)}
              >
                <title>{tooltipText}</title>

                {/* Hit target */}
                <circle cx={p.x} cy={p.y} r={20} fill="transparent" />

                {isSelected && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={26}
                    fill="none"
                    stroke="#f43f5e"
                    strokeWidth="2.2"
                    strokeDasharray="4 3"
                  />
                )}

                {/* Outer halo */}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={
                    isSelected
                      ? 20
                      : n.kind === 'session'
                        ? 15
                        : n.kind === 'note'
                          ? 13
                          : 9
                  }
                  fill={color}
                  opacity={isSelected ? 0.35 : isHi ? 0.22 : 0.14}
                />

                {/* Core dot */}
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={
                    isSelected
                      ? 11
                      : n.kind === 'session'
                        ? 8.5
                        : n.kind === 'note'
                          ? 7.5
                          : 5.5
                  }
                  fill={color}
                  stroke={isSelected || isHovered ? 'var(--foreground)' : 'none'}
                  strokeWidth={isSelected ? 2 : isHovered ? 1.5 : 0}
                />

                {/* Orbital Selected Pin Badge */}
                {isSelected && (
                  <g key={`orb-pin-${n.id}`}>
                    <rect
                      x={Math.max(4, Math.min(width - 196, p.x - 96))}
                      y={pinRectY}
                      width={192}
                      height={21}
                      rx={10.5}
                      fill="#0f172a"
                      stroke="#f43f5e"
                      strokeWidth="1.6"
                    />
                    <text
                      x={Math.max(100, Math.min(width - 100, p.x))}
                      y={pinTextY}
                      fill="#ffffff"
                      fontSize="10"
                      fontWeight="700"
                      textAnchor="middle"
                    >
                      ● จุดที่เลือก: {shortText.slice(0, 22)}
                    </text>
                  </g>
                )}

                {/* Spotlight / Hover Label */}
                {showOrbLabel && (
                  <text
                    x={labelX}
                    y={labelY}
                    fill="var(--foreground)"
                    fontSize={isHovered ? '11' : '10'}
                    fontWeight={isHovered ? '700' : '600'}
                    textAnchor={labelAnchor}
                    stroke="var(--background)"
                    strokeWidth="3.5"
                    strokeLinejoin="round"
                    paintOrder="stroke"
                    pointerEvents="none"
                  >
                    {shortText.length > 26 ? shortText.slice(0, 25) + '…' : shortText}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {/* Footer tips and color legend */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mt-2 px-1 text-xs text-muted-foreground flex-wrap">
        <span>
          เคล็ดลับ: กด Ctrl + หมุนลูกกลิ้งเมาส์เพื่อซูม (Zoom) • คลิกค้างแล้วลากเพื่อเลื่อนดู (Pan) • กด &apos;ซูมดูจุดที่เลือก&apos; หรือดับเบิลคลิกที่โหนดความจำเพื่อเปิดอ่านทันที
        </span>
        <div className="flex items-center gap-3 font-semibold shrink-0 flex-wrap">
          <span className="text-[#38bdf8]">● เซสชัน AI</span>
          <span className="text-[#6366f1]">● ความจำ (ADR/Insight)</span>
          <span className="text-[#ef4444]">● ข้อผิดพลาด/Triad</span>
          <span className="text-[#10b981]">● ไฟล์โค้ด</span>
          <span className="text-[#f59e0b]">● ฟังก์ชัน/คลาส</span>
        </div>
      </div>
    </div>
  );
}
