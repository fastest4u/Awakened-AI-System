import {
  Network,
  GitBranch,
  Cpu,
  Layers,
  FileText,
  Code2,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { shortNodeDisplayLabel } from '@/lib/graph-labels';
import { isImeComposing } from '@/lib/keyboard';
import type { GraphNode } from '@/api/types';

export interface GraphToolbarProps {
  layoutMode: 'flow' | 'orbital';
  onLayoutModeChange: (mode: 'flow' | 'orbital') => void;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  sessionFilter: string;
  onSessionChange: (value: string) => void;
  sessionNodesList: GraphNode[];
  noteNodesList?: GraphNode[];
  selectedNodeId?: string | null;
  onSelectNoteNode?: (nodeId: string) => void;
  kindFilter: string;
  onKindChange: (kind: string) => void;
  totalFilteredCount: number;
  stats: {
    sessionNodes?: number;
    noteNodes?: number;
    fileNodes?: number;
    symbolNodes?: number;
    edgeCount?: number;
  };
}

export function GraphToolbar({
  layoutMode,
  onLayoutModeChange,
  searchQuery,
  onSearchChange,
  sessionFilter,
  onSessionChange,
  sessionNodesList,
  noteNodesList,
  selectedNodeId,
  onSelectNoteNode,
  kindFilter,
  onKindChange,
  totalFilteredCount,
  stats,
}: GraphToolbarProps) {
  const selectedNoteValue =
    selectedNodeId && noteNodesList?.some((nn) => nn.id === selectedNodeId)
      ? selectedNodeId
      : '';
  const activeKind = kindFilter || 'all';

  return (
    <CardHeader className="space-y-3 pb-3">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 flex-wrap">
        <div>
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            <Network className="size-4 text-[#38bdf8]" />
            <span>แผนผังความเชื่อมโยงเข้าใจง่าย: เซสชัน AI ➔ ความจำ ➔ ไฟล์ ➔ โค้ด</span>
          </CardTitle>
          <CardDescription className="text-xs text-muted-foreground mt-1">
            คลิกที่รายการใดก็ได้ในกราฟ ระบบจะไฮไลต์เส้นทางที่เชื่อมโยงกันและสรุปเป็นภาษาคนที่อ่านเข้าใจได้ทันทีทางด้านขวา
          </CardDescription>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap shrink-0">
          <Button
            type="button"
            size="sm"
            variant={layoutMode === 'flow' ? 'default' : 'secondary'}
            onClick={() => onLayoutModeChange('flow')}
            className="h-8 gap-1.5 text-xs"
          >
            <GitBranch className="size-3.5" />
            <span>มุมมองลำดับเรื่องราว (อ่านง่าย)</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={layoutMode === 'orbital' ? 'default' : 'secondary'}
            onClick={() => onLayoutModeChange('orbital')}
            className="h-8 gap-1.5 text-xs"
          >
            <Network className="size-3.5" />
            <span>มุมมองเครือข่ายวงโคจร</span>
          </Button>
        </div>
      </div>

      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-2.5 pt-2 border-t border-border flex-wrap">
        <div className="flex items-center gap-2 flex-1 min-w-[260px] flex-wrap">
          <Input
            id="graph-search-input"
            type="text"
            placeholder="ค้นหาชื่อเรื่อง, ชื่อไฟล์ หรือฟังก์ชันในกราฟ..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return;
            }}
            className="h-8 text-xs max-w-[280px]"
          />

          <select
            id="graph-session-filter"
            value={sessionFilter || 'all'}
            onChange={(e) => onSessionChange(e.target.value)}
            className="h-8 max-w-[240px] truncate rounded-md border border-input bg-card px-2.5 py-1 text-xs text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
          >
            <option value="all">ทุกเซสชัน AI (All Sessions)</option>
            {sessionNodesList.map((sn) => {
              const val = sn.sessionId || sn.id;
              const shortId = String(sn.sessionId || '').slice(0, 6);
              const label = shortNodeDisplayLabel(sn);
              return (
                <option key={sn.id} value={val}>
                  #{shortId} — {label}
                </option>
              );
            })}
          </select>

          {noteNodesList && noteNodesList.length > 0 && onSelectNoteNode && (
            <select
              id="graph-note-select"
              value={selectedNoteValue}
              onChange={(e) => {
                if (e.target.value) onSelectNoteNode(e.target.value);
              }}
              aria-label="เลือกเรื่องที่สนใจเพื่อโฟกัส"
              className="h-8 max-w-[240px] truncate rounded-md border border-input bg-card px-2.5 py-1 text-xs text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
            >
              <option value="">เลือกเรื่องที่สนใจ ({noteNodesList.length})</option>
              {noteNodesList.map((nn) => (
                <option key={nn.id} value={nn.id}>
                  {shortNodeDisplayLabel(nn)}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-1.5 flex-wrap shrink-0">
          <Button
            type="button"
            size="sm"
            variant={activeKind === 'all' ? 'default' : 'secondary'}
            onClick={() => onKindChange('all')}
            className="h-8 text-xs px-2.5"
          >
            ทั้งหมด ({totalFilteredCount})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeKind === 'session' ? 'default' : 'secondary'}
            onClick={() => onKindChange('session')}
            className="h-8 gap-1.5 text-xs px-2.5"
          >
            <Cpu className="size-3 text-[#38bdf8]" />
            <span>เซสชัน ({stats.sessionNodes ?? 0})</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeKind === 'note' ? 'default' : 'secondary'}
            onClick={() => onKindChange('note')}
            className="h-8 gap-1.5 text-xs px-2.5"
          >
            <Layers className="size-3 text-[#6366f1]" />
            <span>ความจำ ({stats.noteNodes ?? 0})</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeKind === 'file' ? 'default' : 'secondary'}
            onClick={() => onKindChange('file')}
            className="h-8 gap-1.5 text-xs px-2.5"
          >
            <FileText className="size-3 text-[#10b981]" />
            <span>ไฟล์ ({stats.fileNodes ?? 0})</span>
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeKind === 'symbol' ? 'default' : 'secondary'}
            onClick={() => onKindChange('symbol')}
            className="h-8 gap-1.5 text-xs px-2.5"
          >
            <Code2 className="size-3 text-[#f59e0b]" />
            <span>โค้ด ({stats.symbolNodes ?? 0})</span>
          </Button>
        </div>
      </div>
    </CardHeader>
  );
}
