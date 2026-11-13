import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface CopyButtonProps extends React.ComponentProps<typeof Button> {
  value: string;
  label: string;
  toastMessage?: string;
}

export function CopyButton({
  value,
  label,
  toastMessage,
  className,
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(toastMessage ?? `คัดลอก ${label} เรียบร้อยแล้ว`);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('ไม่สามารถคัดลอกได้');
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn('h-7 gap-1.5 px-2 text-xs', className)}
      onClick={handleCopy}
      {...props}
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5 text-muted-foreground" />
      )}
      <span>{label}</span>
    </Button>
  );
}
