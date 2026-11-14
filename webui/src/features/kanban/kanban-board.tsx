import { Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { NoteCard } from './note-card';
import type { NoteItem } from '@/api/types';

export interface KanbanBoardProps {
  candidates: NoteItem[];
  verified: NoteItem[];
  archived: NoteItem[];
  onPromote: (recordId: string) => void;
  onInspect: (recordId: string) => void;
  onOpenInGraph: (recordId: string) => void;
  onExpire: (recordId: string, title: string) => void;
  onRetract: (recordId: string, title: string) => void;
  isPending?: boolean;
}

export function KanbanBoard({
  candidates,
  verified,
  archived,
  onPromote,
  onInspect,
  onOpenInGraph,
  onExpire,
  onRetract,
  isPending = false,
}: KanbanBoardProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 items-start">
      {/* Column 1: Candidates */}
      <Card className="flex flex-col bg-card/40 border-border/60 rounded-xl overflow-hidden shadow-xs">
        <CardHeader className="py-3 px-4 bg-muted/20 border-b border-border/40">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <Clock className="size-4 text-[#f59e0b]" />
              <span>รออนุมัติ (Candidates)</span>
            </CardTitle>
            <Badge variant="warning" className="text-xs px-2 py-0.5">
              {candidates.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-3.5 space-y-3 min-h-[240px]">
          {candidates.length === 0 ? (
            <div className="text-center py-12 text-xs text-muted-foreground/70">
              ไม่มีข้อมูลความจำรออนุมัติ
            </div>
          ) : (
            candidates.map((note) => (
              <NoteCard
                key={note.id || note.recordId}
                note={note}
                onPromote={onPromote}
                onInspect={onInspect}
                onOpenInGraph={onOpenInGraph}
                onExpire={onExpire}
                onRetract={onRetract}
                isPending={isPending}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Column 2: Verified */}
      <Card className="flex flex-col bg-card/40 border-border/60 rounded-xl overflow-hidden shadow-xs">
        <CardHeader className="py-3 px-4 bg-muted/20 border-b border-border/40">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <CheckCircle2 className="size-4 text-[#10b981]" />
              <span>ยืนยันแล้ว (Verified)</span>
            </CardTitle>
            <Badge variant="success" className="text-xs px-2 py-0.5">
              {verified.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-3.5 space-y-3 min-h-[240px]">
          {verified.length === 0 ? (
            <div className="text-center py-12 text-xs text-muted-foreground/70">
              ไม่มีข้อมูลความจำที่ยืนยันแล้ว
            </div>
          ) : (
            verified.map((note) => (
              <NoteCard
                key={note.id || note.recordId}
                note={note}
                onPromote={onPromote}
                onInspect={onInspect}
                onOpenInGraph={onOpenInGraph}
                onExpire={onExpire}
                onRetract={onRetract}
                isPending={isPending}
              />
            ))
          )}
        </CardContent>
      </Card>

      {/* Column 3: Archived / Stale / Conflicted */}
      <Card className="flex flex-col bg-card/40 border-border/60 rounded-xl overflow-hidden shadow-xs">
        <CardHeader className="py-3 px-4 bg-muted/20 border-b border-border/40">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="size-4 text-[#ef4444]" />
              <span>ขัดแย้ง / หมดอายุ</span>
            </CardTitle>
            <Badge variant="destructive" className="text-xs px-2 py-0.5">
              {archived.length}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="p-3.5 space-y-3 min-h-[240px]">
          {archived.length === 0 ? (
            <div className="text-center py-12 text-xs text-muted-foreground/70">
              ไม่มีข้อมูลความจำที่ขัดแย้งหรือหมดอายุ
            </div>
          ) : (
            archived.map((note) => (
              <NoteCard
                key={note.id || note.recordId}
                note={note}
                onPromote={onPromote}
                onInspect={onInspect}
                onOpenInGraph={onOpenInGraph}
                onExpire={onExpire}
                onRetract={onRetract}
                isPending={isPending}
              />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
