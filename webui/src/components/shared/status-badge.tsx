import React from 'react';
import { Badge } from '@/components/ui/badge';
import { statusBadgeVariant } from '@/lib/status';
import { cn } from '@/lib/utils';

interface StatusBadgeProps extends React.ComponentProps<typeof Badge> {
  status: string;
}

export function StatusBadge({ status, className, ...props }: StatusBadgeProps) {
  const variant = statusBadgeVariant(status);
  const s = (status || '').toLowerCase().trim();

  let label = status;
  if (s === 'verified' || s === 'active') {
    label = 'ยืนยันแล้ว (Verified)';
  } else if (s === 'candidate' || s === 'provisional') {
    label = 'รออนุมัติ (Candidate)';
  } else if (s === 'conflicted') {
    label = 'ขัดแย้ง (Conflicted)';
  } else if (s === 'expired') {
    label = 'หมดอายุ (Expired)';
  } else if (s === 'superseded') {
    label = 'ถูกแทนที่ (Superseded)';
  } else if (s === 'retracted') {
    label = 'ถอนคืน (Retracted)';
  }

  return (
    <Badge
      variant={variant}
      className={cn('text-xs font-medium', className)}
      {...props}
    >
      {label}
    </Badge>
  );
}
