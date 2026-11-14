import { useState, useMemo } from 'react';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { KindBadge } from '@/components/shared/kind-badge';
import { StatusBadge } from '@/components/shared/status-badge';
import { NoteBadgeList } from '@/components/shared/note-badge-list';
import { deriveHumanTitle } from '@/lib/note';
import { ArrowUpDown, ArrowUp, ArrowDown, Check, Search, Share2 } from 'lucide-react';
import type { NoteItem } from '@/api/types';

export interface NotesTableProps {
  notes: NoteItem[];
  onPromote: (recordId: string) => void;
  onInspect: (recordId: string) => void;
  onOpenInGraph: (recordId: string) => void;
  onExpire: (recordId: string, title: string) => void;
  onRetract: (recordId: string, title: string) => void;
  isPending?: boolean;
}

type SortField = 'kind' | 'title' | 'status';

export function NotesTable({
  notes,
  onPromote,
  onInspect,
  onOpenInGraph,
  onExpire,
  onRetract,
  isPending = false,
}: NotesTableProps) {
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const handleHeaderClick = (field: SortField) => {
    if (sortField === field) {
      setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortOrder('asc');
    }
  };

  const sortedNotes = useMemo(() => {
    if (!sortField) return notes;
    const sorted = [...notes].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'kind') {
        const kA = (a.recordKind || a.kind || '').toLowerCase();
        const kB = (b.recordKind || b.kind || '').toLowerCase();
        comparison = kA.localeCompare(kB);
      } else if (sortField === 'title') {
        const tA = deriveHumanTitle(a);
        const tB = deriveHumanTitle(b);
        comparison = tA.localeCompare(tB);
      } else if (sortField === 'status') {
        const sA = (a.status || '').toLowerCase();
        const sB = (b.status || '').toLowerCase();
        comparison = sA.localeCompare(sB);
      }
      return sortOrder === 'asc' ? comparison : -comparison;
    });
    return sorted;
  }, [notes, sortField, sortOrder]);

  const renderSortIcon = (field: SortField) => {
    if (sortField !== field) {
      return <ArrowUpDown className="size-3 text-muted-foreground/60" />;
    }
    return sortOrder === 'asc' ? (
      <ArrowUp className="size-3 text-primary" />
    ) : (
      <ArrowDown className="size-3 text-primary" />
    );
  };

  return (
    <Card className="w-full bg-card/60 border-border/70 rounded-xl overflow-hidden shadow-xs">
      <CardContent className="p-0">
        <Table>
          <TableHeader className="bg-muted/30">
            <TableRow>
              <TableHead
                className="w-[180px] cursor-pointer select-none text-xs font-semibold"
                onClick={() => handleHeaderClick('kind')}
              >
                <div className="flex items-center gap-1.5">
                  <span>หมวดหมู่</span>
                  {renderSortIcon('kind')}
                </div>
              </TableHead>
              <TableHead
                className="cursor-pointer select-none text-xs font-semibold"
                onClick={() => handleHeaderClick('title')}
              >
                <div className="flex items-center gap-1.5">
                  <span>หัวข้อ (Title)</span>
                  {renderSortIcon('title')}
                </div>
              </TableHead>
              <TableHead
                className="w-[180px] cursor-pointer select-none text-xs font-semibold"
                onClick={() => handleHeaderClick('status')}
              >
                <div className="flex items-center gap-1.5">
                  <span>สถานะ</span>
                  {renderSortIcon('status')}
                </div>
              </TableHead>
              <TableHead className="w-[300px] text-xs font-semibold text-right pr-4">
                จัดการ
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedNotes.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={4}
                  className="h-32 text-center text-xs text-muted-foreground"
                >
                  ไม่พบข้อมูลความจำ
                </TableCell>
              </TableRow>
            ) : (
              sortedNotes.map((note) => {
                const title = deriveHumanTitle(note);
                const isCandidate =
                  note.status === 'candidate' || note.status === 'provisional';

                return (
                  <TableRow
                    key={note.id || note.recordId}
                    className="hover:bg-muted/40 transition-colors"
                  >
                    <TableCell className="align-top py-3">
                      <KindBadge kind={note.kind || note.recordKind} />
                    </TableCell>
                    <TableCell className="align-top py-3">
                      <div className="space-y-1.5 max-w-[480px]">
                        <span
                          onClick={() => onInspect(note.recordId)}
                          className="font-medium text-xs text-foreground hover:text-primary cursor-pointer line-clamp-2 transition-colors"
                          title={title}
                        >
                          {title}
                        </span>
                        {note.summary && (
                          <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                            {note.summary}
                          </p>
                        )}
                        <NoteBadgeList
                          filePaths={note.filePaths}
                          symbols={note.symbols}
                          recordId={note.recordId}
                          onOpenNote={() => onInspect(note.recordId)}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="align-top py-3">
                      <StatusBadge status={note.status} />
                    </TableCell>
                    <TableCell className="align-top py-3 text-right pr-4">
                      <div className="flex items-center justify-end gap-1 flex-wrap">
                        {isCandidate && (
                          <Button
                            type="button"
                            size="sm"
                            onClick={() => onPromote(note.recordId)}
                            disabled={isPending}
                            className="h-7 px-2 text-xs bg-[#10b981] hover:bg-[#10b981]/90 text-white gap-1"
                          >
                            <Check className="size-3" />
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
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
