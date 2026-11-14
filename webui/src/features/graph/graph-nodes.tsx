import { memo } from 'react';
import {
  Handle,
  Position,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import {
  ArrowUpRight,
  Braces,
  CheckCircle2,
  Cpu,
  FileCode2,
  GitBranch,
  Lightbulb,
  OctagonAlert,
  Sparkles,
} from 'lucide-react';
import type { GraphNode } from '@/api/types';
import { CARD_DIMENSIONS } from '@/lib/elk-graph-layout';
import { fullNodeTooltipLabel } from '@/lib/graph-labels';
import { cn } from '@/lib/utils';

export interface GraphCardNodeData extends Record<string, unknown> {
  node: GraphNode;
  isSelected: boolean;
  isHighlighted: boolean;
  onOpenNote?: (recordId: string) => void;
}

export type SessionCardFlowNode = Node<GraphCardNodeData, 'sessionCard'>;
export type MemoryNoteCardFlowNode = Node<GraphCardNodeData, 'noteCard'>;
export type FileCardFlowNode = Node<GraphCardNodeData, 'fileCard'>;
export type SymbolCardFlowNode = Node<GraphCardNodeData, 'symbolCard'>;
export type GraphFlowNode =
  | SessionCardFlowNode
  | MemoryNoteCardFlowNode
  | FileCardFlowNode
  | SymbolCardFlowNode;

interface CardPortsProps {
  accentHex: string;
  active: boolean;
}

function CardPorts({ accentHex, active }: CardPortsProps) {
  const portClass = cn(
    '!w-2 !h-2 !border !border-background/80 !pointer-events-none transition-opacity duration-200',
    active ? '!opacity-85' : '!opacity-25 group-hover:!opacity-75',
  );
  const style = { backgroundColor: accentHex };

  return (
    <>
      <Handle id="in-left" type="target" position={Position.Left} className={portClass} style={style} />
      <Handle id="out-left" type="source" position={Position.Left} className={portClass} style={style} />
      <Handle id="in-right" type="target" position={Position.Right} className={portClass} style={style} />
      <Handle id="out-right" type="source" position={Position.Right} className={portClass} style={style} />
      <Handle id="in-top" type="target" position={Position.Top} className={portClass} style={style} />
      <Handle id="out-top" type="source" position={Position.Top} className={portClass} style={style} />
      <Handle id="in-bottom" type="target" position={Position.Bottom} className={portClass} style={style} />
      <Handle id="out-bottom" type="source" position={Position.Bottom} className={portClass} style={style} />
    </>
  );
}

interface SubkindTheme {
  label: string;
  accentHex: string;
  gradientClass: string;
  badgeClass: string;
  Icon: typeof Lightbulb;
}

function getNoteSubkindTheme(subkind?: string): SubkindTheme {
  switch (subkind) {
    case 'adr':
      return {
        label: 'การตัดสินใจ (ADR)',
        accentHex: '#8b5cf6',
        gradientClass: 'from-[#8b5cf6] to-[#6366f1]',
        badgeClass: 'bg-[#8b5cf6]/15 text-[#a78bfa] border-[#8b5cf6]/35',
        Icon: GitBranch,
      };
    case 'mistake':
      return {
        label: 'ข้อผิดพลาด',
        accentHex: '#f43f5e',
        gradientClass: 'from-[#f43f5e] to-[#fb7185]',
        badgeClass: 'bg-[#f43f5e]/15 text-[#fb7185] border-[#f43f5e]/35',
        Icon: OctagonAlert,
      };
    case 'checkpoint':
      return {
        label: 'จุดตรวจสอบ',
        accentHex: '#10b981',
        gradientClass: 'from-[#10b981] to-[#14b8a6]',
        badgeClass: 'bg-[#10b981]/15 text-[#34d399] border-[#10b981]/35',
        Icon: CheckCircle2,
      };
    case 'insight':
      return {
        label: 'บทเรียน',
        accentHex: '#3b82f6',
        gradientClass: 'from-[#3b82f6] to-[#0ea5e9]',
        badgeClass: 'bg-[#3b82f6]/15 text-[#60a5fa] border-[#3b82f6]/35',
        Icon: Lightbulb,
      };
    default:
      return {
        label: 'บันทึกความจำ',
        accentHex: '#6366f1',
        gradientClass: 'from-[#6366f1] to-[#8b5cf6]',
        badgeClass: 'bg-[#6366f1]/15 text-[#818cf8] border-[#6366f1]/35',
        Icon: Sparkles,
      };
  }
}

function splitFilePath(rawPath: string): { dir: string; base: string } {
  const normalized = rawPath.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) {
    return { dir: '', base: normalized };
  }
  return {
    dir: normalized.slice(0, idx),
    base: normalized.slice(idx + 1),
  };
}

export const SessionCardNode = memo(function SessionCardNode({
  data,
}: NodeProps<SessionCardFlowNode>) {
  const { node, isSelected, isHighlighted } = data;
  const dim = CARD_DIMENSIONS.session;
  const sessionHash = (node.sessionId || node.id.replace(/^session:/, '')).slice(0, 7);
  const cleanedTask = String(node.currentTask || '')
    .replace(/^(?:ADR|Mistake|Insight):\s*/i, '')
    .trim();
  const titleText =
    cleanedTask && cleanedTask !== 'AI Agent Working Session'
      ? cleanedTask
      : node.label && node.label !== 'AI Agent Working Session'
        ? node.label
        : `เซสชัน #${sessionHash}`;

  return (
    <div
      data-node-id={node.id}
      data-node-kind="session"
      data-selected={isSelected ? 'true' : 'false'}
      data-highlighted={isHighlighted ? 'true' : 'false'}
      title={fullNodeTooltipLabel(node)}
      style={{ width: dim.width, minHeight: dim.height }}
      className={cn(
        'group relative flex flex-col justify-between overflow-hidden rounded-xl border bg-card/85 text-foreground backdrop-blur-md shadow-md transition-all duration-200 cursor-pointer select-none',
        isSelected
          ? 'border-[#0ea5e9] ring-2 ring-[#0ea5e9]/45 shadow-[0_0_26px_-4px_rgba(14,165,233,0.55)] opacity-100'
          : isHighlighted
            ? 'border-[#0ea5e9]/60 shadow-[0_6px_20px_-6px_rgba(14,165,233,0.3)] opacity-100'
            : 'border-border/80 opacity-45 hover:opacity-95',
      )}
    >
      <CardPorts accentHex="#0ea5e9" active={isSelected || isHighlighted} />
      <div className="h-1 w-full bg-gradient-to-r from-[#0ea5e9] to-[#06b6d4]" />
      <div className="flex flex-1 flex-col justify-between gap-1.5 p-2.5">
        <div className="flex items-center justify-between gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md border border-[#0ea5e9]/35 bg-[#0ea5e9]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#38bdf8]">
            <Cpu className="size-3 shrink-0" />
            <span>เซสชัน AI</span>
          </span>
          <span className="rounded bg-muted/80 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            #{sessionHash}
          </span>
        </div>

        <p className="text-xs font-semibold leading-snug text-foreground line-clamp-2 break-words">
          {titleText}
        </p>

        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>
            {typeof node.noteCount === 'number'
              ? `${node.noteCount} ความจำในภารกิจ`
              : node.status || 'session'}
          </span>
          {isSelected && (
            <span className="font-semibold text-[#38bdf8]">● จุดที่เลือก</span>
          )}
        </div>
      </div>
    </div>
  );
});

export const MemoryNoteCardNode = memo(function MemoryNoteCardNode({
  data,
}: NodeProps<MemoryNoteCardFlowNode>) {
  const { node, isSelected, isHighlighted, onOpenNote } = data;
  const dim = CARD_DIMENSIONS.note;
  const theme = getNoteSubkindTheme(node.subkind);
  const SubkindIcon = theme.Icon;
  const titleText =
    String(node.label || '')
      .replace(/^(?:ADR|Mistake|Insight):\s*/i, '')
      .trim() || 'บันทึกความจำ';

  return (
    <div
      data-node-id={node.id}
      data-node-kind="note"
      data-selected={isSelected ? 'true' : 'false'}
      data-highlighted={isHighlighted ? 'true' : 'false'}
      title={fullNodeTooltipLabel(node)}
      style={{ width: dim.width, minHeight: dim.height }}
      className={cn(
        'group relative flex flex-col justify-between overflow-hidden rounded-2xl border bg-card/90 text-foreground backdrop-blur-xl shadow-lg transition-all duration-200 cursor-pointer select-none',
        isSelected
          ? 'border-[#a855f7] ring-2 ring-[#a855f7]/50 shadow-[0_0_32px_-4px_rgba(168,85,247,0.55)] opacity-100'
          : isHighlighted
            ? 'border-[#8b5cf6]/55 shadow-[0_8px_24px_-8px_rgba(139,92,246,0.35)] opacity-100'
            : 'border-border/80 opacity-45 hover:opacity-95',
      )}
    >
      <CardPorts accentHex={theme.accentHex} active={isSelected || isHighlighted} />
      <div className={cn('h-1.5 w-full bg-gradient-to-r', theme.gradientClass)} />
      <div className="flex flex-1 flex-col justify-between gap-2 p-3">
        <div className="flex items-center justify-between gap-1.5">
          <span
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold',
              theme.badgeClass,
            )}
          >
            <SubkindIcon className="size-3 shrink-0" />
            <span>{theme.label}</span>
          </span>

          <div className="flex items-center gap-1 shrink-0">
            {node.status && (
              <span className="rounded bg-muted/90 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {node.status}
              </span>
            )}
            {node.recordId && (
              <button
                type="button"
                data-action="open-note"
                title="เปิดอ่านบันทึกฉบับเต็ม"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  if (node.recordId) {
                    onOpenNote?.(node.recordId);
                  }
                }}
                className="nodrag nopan inline-flex items-center gap-0.5 rounded-md border border-border bg-background/70 px-1.5 py-0.5 text-[10px] font-semibold text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <ArrowUpRight className="size-2.5" />
                <span>อ่าน</span>
              </button>
            )}
          </div>
        </div>

        <div className="space-y-1">
          <h4 className="text-[13px] font-bold leading-snug text-foreground line-clamp-2 break-words">
            {titleText}
          </h4>
          {node.summary && (
            <p className="text-[11px] leading-snug text-muted-foreground line-clamp-1">
              {node.summary}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground pt-0.5 border-t border-border/50">
          <span className="truncate font-mono">
            {node.filePaths?.length ? `${node.filePaths.length} ไฟล์` : node.recordId?.slice(0, 8) || 'note'}
          </span>
          {isSelected && (
            <span className="shrink-0 font-semibold text-[#c084fc]">
              ● จุดที่เลือก
            </span>
          )}
        </div>
      </div>
    </div>
  );
});

export const FileCardNode = memo(function FileCardNode({
  data,
}: NodeProps<FileCardFlowNode>) {
  const { node, isSelected, isHighlighted } = data;
  const dim = CARD_DIMENSIONS.file;
  const rawLabel = String(node.label || node.id.replace(/^file:/, '')).trim();
  const { dir, base } = splitFilePath(rawLabel);

  return (
    <div
      data-node-id={node.id}
      data-node-kind="file"
      data-selected={isSelected ? 'true' : 'false'}
      data-highlighted={isHighlighted ? 'true' : 'false'}
      title={fullNodeTooltipLabel(node)}
      style={{ width: dim.width, minHeight: dim.height }}
      className={cn(
        'group relative flex flex-col justify-between overflow-hidden rounded-xl border bg-card/85 text-foreground backdrop-blur-md shadow-sm transition-all duration-200 cursor-pointer select-none',
        isSelected
          ? 'border-[#10b981] ring-2 ring-[#10b981]/45 shadow-[0_0_24px_-4px_rgba(16,185,129,0.5)] opacity-100'
          : isHighlighted
            ? 'border-[#10b981]/55 shadow-[0_6px_18px_-6px_rgba(16,185,129,0.28)] opacity-100'
            : 'border-border/80 opacity-45 hover:opacity-95',
      )}
    >
      <CardPorts accentHex="#10b981" active={isSelected || isHighlighted} />
      <div className="h-1 w-full bg-gradient-to-r from-[#10b981] to-[#14b8a6]" />
      <div className="flex flex-1 flex-col justify-between gap-1 px-2.5 py-2">
        <div className="flex items-center justify-between gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-md border border-[#10b981]/35 bg-[#10b981]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#34d399]">
            <FileCode2 className="size-3 shrink-0" />
            <span>ไฟล์โค้ด</span>
          </span>
          {isSelected && (
            <span className="text-[10px] font-semibold text-[#34d399]">
              ● จุดที่เลือก
            </span>
          )}
        </div>
        <div className="min-w-0">
          {dir && (
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {dir}/
            </p>
          )}
          <p className="truncate font-mono text-xs font-semibold text-foreground">
            {base}
          </p>
        </div>
      </div>
    </div>
  );
});

export const SymbolCardNode = memo(function SymbolCardNode({
  data,
}: NodeProps<SymbolCardFlowNode>) {
  const { node, isSelected, isHighlighted } = data;
  const dim = CARD_DIMENSIONS.symbol;
  const label = String(node.label || node.id.replace(/^symbol:/, '')).trim();

  return (
    <div
      data-node-id={node.id}
      data-node-kind="symbol"
      data-selected={isSelected ? 'true' : 'false'}
      data-highlighted={isHighlighted ? 'true' : 'false'}
      title={fullNodeTooltipLabel(node)}
      style={{ width: dim.width, minHeight: dim.height }}
      className={cn(
        'group relative flex flex-col justify-between overflow-hidden rounded-xl border bg-card/85 text-foreground backdrop-blur-md shadow-sm transition-all duration-200 cursor-pointer select-none',
        isSelected
          ? 'border-[#f59e0b] ring-2 ring-[#f59e0b]/45 shadow-[0_0_24px_-4px_rgba(245,158,11,0.5)] opacity-100'
          : isHighlighted
            ? 'border-[#f59e0b]/55 shadow-[0_6px_18px_-6px_rgba(245,158,11,0.28)] opacity-100'
            : 'border-border/80 opacity-45 hover:opacity-95',
      )}
    >
      <CardPorts accentHex="#f59e0b" active={isSelected || isHighlighted} />
      <div className="h-1 w-full bg-gradient-to-r from-[#f59e0b] to-[#f97316]" />
      <div className="flex flex-1 flex-col justify-between gap-1 px-2.5 py-2">
        <div className="flex items-center justify-between gap-1">
          <span className="inline-flex items-center gap-1 rounded-md border border-[#f59e0b]/35 bg-[#f59e0b]/15 px-1.5 py-0.5 text-[10px] font-semibold text-[#fbbf24]">
            <Braces className="size-3 shrink-0" />
            <span>โค้ด</span>
          </span>
          {isSelected && (
            <span className="text-[10px] font-semibold text-[#fbbf24]">
              ● เลือก
            </span>
          )}
        </div>
        <p className="truncate font-mono text-xs font-semibold text-foreground">
          {label}
        </p>
      </div>
    </div>
  );
});

export const graphNodeTypes: NodeTypes = {
  sessionCard: SessionCardNode,
  noteCard: MemoryNoteCardNode,
  fileCard: FileCardNode,
  symbolCard: SymbolCardNode,
};
