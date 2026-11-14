import { memo } from 'react';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
} from '@xyflow/react';
import type { GraphEdge } from '@/api/types';
import { cn } from '@/lib/utils';

export interface SemanticGraphEdgeData extends Record<string, unknown> {
  relation: GraphEdge['relation'];
  highlighted: boolean;
  incidentSelected: boolean;
}

export type SemanticFlowEdge = Edge<SemanticGraphEdgeData, 'semantic'>;

interface RelationStyle {
  strokeHex: string;
  thaiLabel: string;
}

const RELATION_STYLE_MAP: Record<GraphEdge['relation'], RelationStyle> = {
  'causal-triad': {
    strokeHex: '#a855f7',
    thaiLabel: 'สัมพันธ์เหตุผล',
  },
  'created-in-session': {
    strokeHex: '#0ea5e9',
    thaiLabel: 'จากเซสชัน',
  },
  'touches-file': {
    strokeHex: '#10b981',
    thaiLabel: 'แก้ไขไฟล์',
  },
  'mentions-symbol': {
    strokeHex: '#f59e0b',
    thaiLabel: 'กล่าวถึงโค้ด',
  },
  'defines-symbol': {
    strokeHex: '#fb923c',
    thaiLabel: 'นิยามโค้ด',
  },
  'links-to-note': {
    strokeHex: '#818cf8',
    thaiLabel: 'เชื่อมบันทึก',
  },
  supersedes: {
    strokeHex: '#f43f5e',
    thaiLabel: 'แทนที่ฉบับเดิม',
  },
  'forked-from': {
    strokeHex: '#06b6d4',
    thaiLabel: 'แยกสาขา',
  },
};

export const SemanticGraphEdge = memo(function SemanticGraphEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<SemanticFlowEdge>) {
  const relation = data?.relation ?? 'links-to-note';
  const highlighted = Boolean(data?.highlighted);
  const incidentSelected = Boolean(data?.incidentSelected);
  const styleMeta = RELATION_STYLE_MAP[relation] ?? RELATION_STYLE_MAP['links-to-note'];

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35,
  });

  const isCausal = relation === 'causal-triad';
  const shouldAnimate = isCausal || incidentSelected;
  const strokeOpacity = highlighted ? 0.92 : 0.22;

  return (
    <>
      {highlighted && (
        <BaseEdge
          id={`${id}-halo`}
          path={edgePath}
          style={{
            stroke: styleMeta.strokeHex,
            strokeWidth: incidentSelected ? 7 : 5,
            strokeOpacity: incidentSelected ? 0.24 : 0.14,
            fill: 'none',
          }}
        />
      )}

      <BaseEdge
        id={id}
        path={edgePath}
        className={cn(shouldAnimate && 'xyflow-edge-animated')}
        style={{
          stroke: styleMeta.strokeHex,
          strokeWidth: highlighted ? (incidentSelected ? 2.4 : 1.9) : 1.15,
          strokeOpacity,
          strokeDasharray: shouldAnimate ? '7 5' : undefined,
          fill: 'none',
        }}
      />

      {highlighted && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'none',
            }}
            className="nodrag nopan rounded-full border border-border/80 bg-card/90 px-2 py-0.5 text-[10px] font-medium text-foreground shadow-sm backdrop-blur-md whitespace-nowrap"
          >
            <span
              className="mr-1 inline-block size-1.5 rounded-full align-middle"
              style={{ backgroundColor: styleMeta.strokeHex }}
            />
            {styleMeta.thaiLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

export const graphEdgeTypes: EdgeTypes = {
  semantic: SemanticGraphEdge,
};
