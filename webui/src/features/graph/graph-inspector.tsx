import {
  Sparkles,
  FileText,
  Kanban,
  Search,
  Cpu,
  Layers,
  Code2,
  Lightbulb,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { humanKindLabel } from '@/lib/graph-labels';
import { isImeComposing } from '@/lib/keyboard';
import type { GraphNode } from '@/api/types';

export interface GraphStory {
  relatedSessions: GraphNode[];
  relatedNotes: GraphNode[];
  relatedFiles: GraphNode[];
  relatedSymbols: GraphNode[];
}

export interface GraphInspectorProps {
  selectedNode: GraphNode | null;
  story: GraphStory;
  sessionFilter: string;
  onSelectNode: (id: string) => void;
  onOpenNote: (recordId: string) => void;
  onOpenInKanban: (query: string) => void;
  onToggleSessionFilter: (sessionId: string) => void;
}

export function GraphInspector({
  selectedNode,
  story,
  sessionFilter,
  onSelectNode,
  onOpenNote,
  onOpenInKanban,
  onToggleSessionFilter,
}: GraphInspectorProps) {
  if (!selectedNode) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <Alert>
          <AlertTitle>คลิกเลือกโหนดในกราฟเพื่ออ่านสรุป</AlertTitle>
          <AlertDescription>
            เมื่อคลิกที่เซสชัน ความจำ ไฟล์ หรือโค้ด ระบบจะแปลความสัมพันธ์เป็นภาษาคนที่เข้าใจง่ายทันที
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const statusLabel =
    selectedNode.status === 'verified'
      ? 'ยืนยันแล้ว (Verified)'
      : selectedNode.status === 'active'
        ? 'กำลังทำงาน (Active)'
        : selectedNode.status === 'completed' || selectedNode.status === 'ended'
          ? 'เสร็จสมบูรณ์'
          : selectedNode.status;

  const statusVariant =
    selectedNode.status === 'verified' || selectedNode.status === 'active'
      ? 'success'
      : selectedNode.status === 'candidate' || selectedNode.status === 'provisional'
        ? 'warning'
        : selectedNode.status === 'conflicted' ||
            selectedNode.status === 'expired' ||
            selectedNode.status === 'superseded' ||
            selectedNode.status === 'retracted'
          ? 'destructive'
          : 'outline';

  const titleText =
    selectedNode.kind === 'session'
      ? selectedNode.currentTask || selectedNode.label
      : selectedNode.label;

  const handleItemKeyDown = (
    e: React.KeyboardEvent,
    action: () => void,
  ) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      action();
    } else if (e.key === 'Enter') {
      if (!isImeComposing(e)) {
        e.preventDefault();
        action();
      }
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      {/* 1. Header & Badges */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <Badge
            variant={
              selectedNode.kind === 'session'
                ? 'default'
                : selectedNode.kind === 'note'
                  ? 'success'
                  : 'secondary'
            }
            className="gap-1 text-xs"
          >
            {selectedNode.kind === 'session' ? (
              <Cpu className="size-3" />
            ) : selectedNode.kind === 'note' ? (
              <Lightbulb className="size-3" />
            ) : selectedNode.kind === 'file' ? (
              <FileText className="size-3" />
            ) : (
              <Code2 className="size-3" />
            )}
            <span>{humanKindLabel(selectedNode)}</span>
          </Badge>

          {selectedNode.status && (
            <Badge variant={statusVariant} className="text-xs">
              {statusLabel}
            </Badge>
          )}
        </div>

        <h4 className="mt-1 text-sm font-bold leading-snug text-foreground">
          {titleText}
        </h4>
      </div>

      {/* 2. Plain-Language Narrative Summary Box */}
      <div className="rounded-lg border border-border bg-background p-3.5 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-bold text-primary">
          <Sparkles className="size-3.5 text-[#f59e0b]" />
          <span>สรุปใจความสำคัญ (อ่านเข้าใจง่าย)</span>
        </div>

        <div className="text-xs leading-relaxed text-foreground">
          {selectedNode.kind === 'note'
            ? selectedNode.summary || selectedNode.label
            : selectedNode.kind === 'session'
              ? `ในเซสชันนี้ AI Agent ได้ดำเนินภารกิจเรื่อง '${selectedNode.currentTask || selectedNode.label}' และได้บันทึกความจำที่เกี่ยวข้องไว้ ${story.relatedNotes.length} รายการ เชื่อมโยงกับไฟล์โค้ด ${story.relatedFiles.length} ไฟล์`
              : selectedNode.kind === 'file'
                ? `ไฟล์ '${selectedNode.label}' ถูกอ้างอิงหรือแก้ไขในความจำของโปรเจกต์จำนวน ${story.relatedNotes.length} เรื่อง และมีฟังก์ชัน/คลาสที่เกี่ยวข้อง ${story.relatedSymbols.length} รายการ`
                : `ฟังก์ชัน/คลาส '${selectedNode.label}' เป็นส่วนประกอบสำคัญที่ถูกกล่าวถึงในความจำ ${story.relatedNotes.length} เรื่อง`}
        </div>

        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {selectedNode.recordId && (
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={() => onOpenNote(selectedNode.recordId!)}
              className="h-7 gap-1.5 text-xs px-2.5"
            >
              <FileText className="size-3" />
              <span>อ่านเนื้อหาฉบับเต็ม</span>
            </Button>
          )}

          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => onOpenInKanban(selectedNode.label || '')}
            className="h-7 gap-1.5 text-xs px-2.5"
          >
            <Kanban className="size-3" />
            <span>เปิดในบอร์ดจัดการ</span>
          </Button>

          {selectedNode.sessionId && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onToggleSessionFilter(selectedNode.sessionId!)}
              className="h-7 gap-1.5 text-xs px-2.5"
            >
              <Search className="size-3" />
              <span>
                {sessionFilter === selectedNode.sessionId
                  ? 'แสดงทุกเซสชัน'
                  : 'กรองดูเฉพาะเซสชันนี้'}
              </span>
            </Button>
          )}
        </div>
      </div>

      {/* 3. Connected Story Relationships */}
      {story.relatedSessions.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#38bdf8]">
            <Cpu className="size-3 text-[#38bdf8]" />
            <span>เซสชัน AI ที่เกี่ยวข้อง ({story.relatedSessions.length})</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {story.relatedSessions.map((sNode) => (
              <button
                type="button"
                key={sNode.id}
                onClick={() => onSelectNode(sNode.id)}
                className="text-left p-2 rounded-lg border border-[hsla(199,89%,48%,0.35)] bg-[hsla(199,89%,48%,0.08)] hover:bg-[hsla(199,89%,48%,0.15)] transition-colors text-xs space-y-0.5 cursor-pointer"
              >
                <div className="font-semibold text-foreground truncate">
                  {sNode.currentTask || sNode.label}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Session #{String(sNode.sessionId || '').slice(0, 8)}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {story.relatedNotes.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#6366f1]">
            <Layers className="size-3 text-[#6366f1]" />
            <span>
              ความจำ & บทเรียนที่เชื่อมโยง ({story.relatedNotes.length} เรื่อง)
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            {story.relatedNotes.slice(0, 5).map((nNode) => (
              <div
                key={nNode.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectNode(nNode.id)}
                onKeyDown={(e) =>
                  handleItemKeyDown(e, () => onSelectNode(nNode.id))
                }
                className="p-2.5 rounded-lg border border-border bg-background hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors cursor-pointer space-y-1 text-xs"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-foreground truncate">
                    {nNode.label}
                  </span>
                  {nNode.recordId && (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenNote(nNode.recordId!);
                      }}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                      }}
                      className="h-6 text-[11px] px-2 shrink-0"
                    >
                      อ่านเต็ม
                    </Button>
                  )}
                </div>
                {nNode.summary && (
                  <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                    {String(nNode.summary).slice(0, 140)}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {story.relatedFiles.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#10b981]">
            <FileText className="size-3 text-[#10b981]" />
            <span>
              ไฟล์ซอร์สโค้ดที่เกี่ยวข้อง ({story.relatedFiles.length} ไฟล์)
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {story.relatedFiles.map((fNode) => (
              <Badge
                key={fNode.id}
                variant="outline"
                role="button"
                tabIndex={0}
                onClick={() => onSelectNode(fNode.id)}
                onKeyDown={(e) =>
                  handleItemKeyDown(e, () => onSelectNode(fNode.id))
                }
                className="cursor-pointer gap-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FileText className="size-3 text-[#10b981]" />
                <span>{fNode.label}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}

      {story.relatedSymbols.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-bold text-[#f59e0b]">
            <Code2 className="size-3 text-[#f59e0b]" />
            <span>
              ฟังก์ชัน / คลาสที่เกี่ยวข้อง ({story.relatedSymbols.length})
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {story.relatedSymbols.slice(0, 12).map((symNode) => (
              <Badge
                key={symNode.id}
                variant="secondary"
                role="button"
                tabIndex={0}
                onClick={() => onSelectNode(symNode.id)}
                onKeyDown={(e) =>
                  handleItemKeyDown(e, () => onSelectNode(symNode.id))
                }
                className="cursor-pointer gap-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Code2 className="size-3 text-[#f59e0b]" />
                <span>{symNode.label}</span>
              </Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
