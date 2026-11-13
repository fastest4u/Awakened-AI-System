import React from 'react';
import { Landmark, Lightbulb, AlertTriangle, FileText } from 'lucide-react';
import { cn } from '@/lib/utils';

interface KindBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  kind: string;
}

export function KindBadge({ kind, className, ...props }: KindBadgeProps) {
  const k = (kind || '').toLowerCase().trim();
  if (k.includes('adr')) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#6366f1]/15 text-[#6366f1] border border-[#6366f1]/30',
          className,
        )}
        {...props}
      >
        <Landmark className="size-3 shrink-0" />
        <span>ADR (การตัดสินใจ)</span>
      </span>
    );
  }
  if (k.includes('insight')) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#10b981]/15 text-[#10b981] border border-[#10b981]/30',
          className,
        )}
        {...props}
      >
        <Lightbulb className="size-3 shrink-0" />
        <span>Insight (บทเรียน)</span>
      </span>
    );
  }
  if (k.includes('mistake')) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#f59e0b]/15 text-[#f59e0b] border border-[#f59e0b]/30',
          className,
        )}
        {...props}
      >
        <AlertTriangle className="size-3 shrink-0" />
        <span>Mistake (ข้อควรระวัง)</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-[#38bdf8]/15 text-[#38bdf8] border border-[#38bdf8]/30',
        className,
      )}
      {...props}
    >
      <FileText className="size-3 shrink-0" />
      <span>{k.includes('session') ? 'Session Log (ประวัติ)' : kind}</span>
    </span>
  );
}
