import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export type StatCardTone = 'emerald' | 'amber' | 'indigo' | 'rose' | 'default';

export interface StatCardProps extends React.ComponentProps<typeof Card> {
  label: string;
  value: React.ReactNode;
  subtitle?: string;
  tone?: StatCardTone;
}

const toneValueClasses: Record<StatCardTone, string> = {
  emerald: 'text-[#10b981] dark:text-[#34d399]',
  amber: 'text-[#f59e0b] dark:text-[#fbbf24]',
  indigo: 'text-[#6366f1] dark:text-[#818cf8]',
  rose: 'text-[#ef4444] dark:text-[#f87171]',
  default: 'text-foreground',
};

const toneBorderClasses: Record<StatCardTone, string> = {
  emerald: 'border-[#10b981]/25 hover:border-[#10b981]/50',
  amber: 'border-[#f59e0b]/25 hover:border-[#f59e0b]/50',
  indigo: 'border-[#6366f1]/25 hover:border-[#6366f1]/50',
  rose: 'border-[#ef4444]/25 hover:border-[#ef4444]/50',
  default: 'border-border',
};

export function StatCard({
  label,
  value,
  subtitle,
  tone = 'default',
  className,
  ...props
}: StatCardProps) {
  return (
    <Card
      className={cn(
        'relative overflow-hidden transition-all duration-200 py-4 px-5',
        toneBorderClasses[tone],
        className,
      )}
      {...props}
    >
      <CardContent className="p-0 flex flex-col justify-between gap-1">
        <span className="text-xs font-medium text-muted-foreground tracking-tight">
          {label}
        </span>
        <div
          className={cn(
            'text-2xl lg:text-3xl font-extrabold tracking-tight',
            toneValueClasses[tone],
          )}
        >
          {value}
        </div>
        {subtitle && (
          <span className="text-[11px] text-muted-foreground/80 font-normal">
            {subtitle}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
