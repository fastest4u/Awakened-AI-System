import { useState, useEffect, type KeyboardEvent } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { isImeComposing } from '@/lib/keyboard';

export interface GovernanceConfirmAction {
  action: 'retract' | 'expire';
  recordId: string;
  title?: string;
}

export interface GovernanceConfirmDialogProps {
  action: GovernanceConfirmAction | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isPending?: boolean;
}

export function GovernanceConfirmDialog({
  action,
  open,
  onOpenChange,
  onConfirm,
  isPending = false,
}: GovernanceConfirmDialogProps) {
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) {
      setReason('');
    }
  }, [open, action]);

  if (!action) return null;

  const isRetract = action.action === 'retract';
  const titleText = isRetract
    ? 'ยืนยันการถอนคืนความจำ (Confirm Retract)'
    : 'ยืนยันการตั้งหมดอายุความจำ (Confirm Expire)';

  const descriptionText = isRetract
    ? `รายการนี้จะถูกถอนคืนออกจากชุดความจำใช้งานจริง: ${action.title || action.recordId}`
    : `รายการนี้จะถูกเปลี่ยนสถานะเป็นหมดอายุ (Expired): ${action.title || action.recordId}`;

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isImeComposing(e)) {
      e.preventDefault();
      onConfirm(reason);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-5 text-destructive shrink-0" />
            <DialogTitle className="text-base font-semibold">
              {titleText}
            </DialogTitle>
          </div>
          <DialogDescription className="text-xs text-muted-foreground pt-1.5 leading-relaxed">
            {descriptionText}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Input
            id="kanban-confirm-reason-input"
            placeholder="ระบุเหตุผลประกอบ (ไม่บังคับ)..."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isPending}
            className="text-sm"
          />
        </div>

        <DialogFooter className="flex justify-end gap-2 sm:gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            ยกเลิก
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => onConfirm(reason)}
            disabled={isPending}
          >
            {isPending ? 'กำลังดำเนินการ...' : 'ยืนยันการดำเนินการ'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
