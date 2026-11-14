import type { HTMLAttributes, MouseEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { FileText, Code2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { capNoteBadges } from '@/lib/kanban';
import { cn } from '@/lib/utils';

export interface NoteBadgeListProps extends HTMLAttributes<HTMLDivElement> {
  filePaths?: string[] | null;
  symbols?: string[] | null;
  recordId?: string;
  onOpenNote?: () => void;
}

export function NoteBadgeList({
  filePaths,
  symbols,
  recordId,
  onOpenNote,
  className,
  ...props
}: NoteBadgeListProps) {
  const navigate = useNavigate();
  const allFiles = Array.isArray(filePaths) ? filePaths : [];
  const allSymbols = Array.isArray(symbols) ? symbols : [];

  const { files, symbols: cappedSymbols, hidden } = capNoteBadges({
    filePaths: allFiles,
    symbols: allSymbols,
  });

  if (files.length === 0 && cappedSymbols.length === 0 && hidden === 0) {
    return null;
  }

  const handleNavigateToFile = (e: MouseEvent, fp: string) => {
    e.stopPropagation();
    navigate({
      to: '/graph',
      search: (prev: any) => ({
        ...prev,
        q: fp,
      }),
    });
  };

  const handleNavigateToSymbol = (e: MouseEvent, sym: string) => {
    e.stopPropagation();
    navigate({
      to: '/graph',
      search: (prev: any) => ({
        ...prev,
        q: sym,
      }),
    });
  };

  const handleOverflowClick = (e: MouseEvent) => {
    e.stopPropagation();
    onOpenNote?.();
  };

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      {...props}
    >
      {files.map((fp) => (
        <Badge
          key={fp}
          variant="outline"
          title={fp}
          onClick={(e) => handleNavigateToFile(e, fp)}
          className="inline-flex items-center gap-1 text-[11px] font-mono cursor-pointer hover:bg-accent transition-colors max-w-[200px] truncate"
        >
          <FileText className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{fp}</span>
        </Badge>
      ))}

      {cappedSymbols.map((sym) => (
        <Badge
          key={sym}
          variant="secondary"
          title={sym}
          onClick={(e) => handleNavigateToSymbol(e, sym)}
          className="inline-flex items-center gap-1 text-[11px] font-mono cursor-pointer hover:bg-muted transition-colors max-w-[160px] truncate"
        >
          <Code2 className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{sym}</span>
        </Badge>
      ))}

      {hidden > 0 && (
        <Badge
          variant="outline"
          title={`คลิกอ่านรายละเอียดทั้งหมด (${allFiles.length} ไฟล์, ${allSymbols.length} สัญลักษณ์)`}
          onClick={handleOverflowClick}
          className="text-[11px] cursor-pointer hover:bg-accent opacity-85 transition-opacity"
        >
          +{hidden} รายการ
        </Badge>
      )}
    </div>
  );
}
