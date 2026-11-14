import { useState, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { isImeComposing } from '@/lib/keyboard';
import { toast } from 'sonner';

export type QuickEntryKind = 'writeADR' | 'writeInsight' | 'writeMistake';

export interface QuickEntryProps {
  onSubmit: (data: {
    action: QuickEntryKind;
    title: string;
    summary: string;
    content: string;
  }) => void;
  isPending?: boolean;
}

export function QuickEntry({ onSubmit, isPending = false }: QuickEntryProps) {
  const [newKind, setNewKind] = useState<QuickEntryKind>('writeADR');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');

  const handleSubmit = () => {
    const cleanTitle = title.trim();
    const cleanSummary = summary.trim();

    if (!cleanTitle || !cleanSummary) {
      toast.warning('กรุณากรอกทั้งหัวข้อ (Title) และรายละเอียด (Summary)');
      return;
    }

    onSubmit({
      action: newKind,
      title: cleanTitle,
      summary: cleanSummary,
      content: cleanSummary,
    });

    setTitle('');
    setSummary('');
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <Card className="w-full shadow-xs">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Plus className="size-4 text-[#6366f1]" />
          <span>เพิ่มความจำใหม่ (Quick Memory Entry)</span>
        </CardTitle>
        <CardDescription className="text-xs text-muted-foreground">
          บันทึกการตัดสินใจ (ADR), บทเรียน (Insight) หรือข้อผิดพลาดที่ต้องระวัง (Mistake)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-[180px_1fr_1.5fr_auto] gap-2.5 items-center">
          <select
            id="kanban-new-kind"
            value={newKind}
            onChange={(e) => setNewKind(e.target.value as QuickEntryKind)}
            disabled={isPending}
            className="h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-xs text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
          >
            <option value="writeADR">ADR (การตัดสินใจ)</option>
            <option value="writeInsight">Insight (บทเรียน)</option>
            <option value="writeMistake">Mistake (ข้อผิดพลาด)</option>
          </select>

          <Input
            id="kanban-new-title"
            placeholder="หัวข้อสั้นๆ เข้าใจง่าย..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isPending}
            className="text-xs h-9"
          />

          <Input
            id="kanban-new-summary"
            placeholder="รายละเอียด + ระบุไฟล์ เช่น src/v2/webui.ts (startV2WebUiServer)..."
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isPending}
            className="text-xs h-9"
          />

          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isPending}
            className="h-9 gap-1 text-xs shrink-0"
          >
            <Plus className="size-3.5" />
            <span>{isPending ? 'กำลังบันทึก...' : 'บันทึก'}</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
