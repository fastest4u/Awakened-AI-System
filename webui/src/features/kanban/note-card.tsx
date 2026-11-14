import { Check, Search, Share2 } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KindBadge } from '@/components/shared/kind-badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { NoteBadgeList } from '@/components/shared/note-badge-list';
import { deriveHumanTitle } from '@/lib/note';
import type { NoteItem } from '@/api/types';

export interface NoteCardProps {
  note: NoteItem;
  onPromote: (recordId: string) => void;
  onInspect: (recordId: string) => void;
  onOpenInGraph: (recordId: string) => void;
  onExpire: (recordId: string, title: string) => void;
  onRetract: (recordId: string, title: string) => void;
  isPending?: boolean;
}

export function NoteCard({
  note,
  onPromote,
  onInspect,
  onOpenInGraph,
  onExpire,
  onRetract,
  isPending = false,
}: NoteCardProps) {
  const title = deriveHumanTitle(note);
  const rawSummary = note.summary || '';
  const truncatedSummary =
    rawSummary.length > 180 ? `${rawSummary.slice(0, 180)}...` : rawSummary;

  const isCandidate =
    note.status === 'candidate' || note.status === 'provisional';

  return (
    <Card className="flex flex-col gap-3 p-4 bg-card/80 hover:bg-card border-border/70 hover:border-border transition-all rounded-xl shadow-xs">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <KindBadge kind={note.kind || note.recordKind} />
        <StatusBadge status={note.status} />
      </div>

      <div className="space-y-1">
        <h4
          onClick={() => onInspect(note.recordId)}
          className="text-sm font-semibold text-foreground tracking-tight line-clamp-2 cursor-pointer hover:text-primary transition-colors"
          title={title}
        >
          {title}
        </h4>
        {truncatedSummary && (
          <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
            {truncatedSummary}
          </p>
        )}
      </div>

      <NoteBadgeList
        filePaths={note.filePaths}
        symbols={note.symbols}
        recordId={note.recordId}
        onOpenNote={() => onInspect(note.recordId)}
      />

      <div className="flex items-center gap-1.5 pt-1 border-t border-border/50 flex-wrap">
        {isCandidate && (
          <Button
            type="button"
            size="sm"
            onClick={() => onPromote(note.recordId)}
            disabled={isPending}
            className="h-7 px-2.5 text-xs bg-[#10b981] hover:bg-[#10b981]/90 text-white gap-1"
          >
            <Check className="size-3.5" />
            <span>อนุมัติ (Promote)</span>
          </Button>
        )}

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onInspect(note.recordId)}
          className="h-7 px-2 text-xs gap-1"
        >
          <Search className="size-3" />
          <span>ดูข้อมูล</span>
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenInGraph(note.recordId)}
          className="h-7 px-2 text-xs gap-1"
        >
          <Share2 className="size-3" />
          <span>ดูในกราฟ</span>
        </Button>

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onExpire(note.recordId, title)}
          disabled={isPending}
          className="h-7 px-2 text-xs"
        >
          หมดอายุ
        </Button>

        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => onRetract(note.recordId, title)}
          disabled={isPending}
          className="h-7 px-2 text-xs"
        >
          ถอนคืน
        </Button>
      </div>
    </Card>
  );
}
