import React from 'react';
import { Wrench, Play, RefreshCw, AlertTriangle } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { isImeComposing } from '@/lib/keyboard';
import { toolSafety } from '@/lib/mcp-template';
import type { McpToolDefinition } from '@/api/types';

interface ToolRunnerProps {
  tools: McpToolDefinition[];
  selectedTool: string;
  onSelectTool: (name: string) => void;
  rawArgs: string;
  onArgsChange: (val: string) => void;
  onInsertParam: (key: string) => void;
  onResetTemplate: () => void;
  onExecute: () => void;
  isPending: boolean;
  isConfirmOpen: boolean;
  onConfirmOpenChange: (open: boolean) => void;
  onConfirmExecute: () => void;
  onCancelConfirm: () => void;
}

export function ToolRunner({
  tools,
  selectedTool,
  onSelectTool,
  rawArgs,
  onArgsChange,
  onInsertParam,
  onResetTemplate,
  onExecute,
  isPending,
  isConfirmOpen,
  onConfirmOpenChange,
  onConfirmExecute,
  onCancelConfirm,
}: ToolRunnerProps) {
  const currentTool = tools.find((t) => t.name === selectedTool) ?? null;
  const safety = toolSafety(currentTool);

  const safetyVariant =
    safety === 'read-only'
      ? 'success'
      : safety === 'destructive'
        ? 'destructive'
        : 'warning';

  const safetyLabel =
    safety === 'read-only'
      ? 'Read-Only (อ่านอย่างเดียว)'
      : safety === 'destructive'
        ? 'Destructive (ลบ/ถอนคืนข้อมูล)'
        : 'Mutating (แก้ไขคลังความจำ)';

  const schemaProps = (currentTool?.inputSchema?.properties || {}) as Record<
    string,
    any
  >;
  const requiredSet = new Set(currentTool?.inputSchema?.required || []);
  const paramKeys = Object.keys(schemaProps);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      onExecute();
    }
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="flex items-center gap-2 text-base">
              <Wrench className="size-4 text-[#6366f1]" />
              ทดสอบคำสั่ง MCP (34 V2 Tools)
            </CardTitle>
            <Badge variant={safetyVariant}>{safetyLabel}</Badge>
          </div>
          <CardDescription>
            เลือกเครื่องมือ ระบบจะสร้าง JSON Template ตาม Schema ให้อัตโนมัติ
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <select
            id="mcp-tool-select"
            aria-label="เลือกคำสั่ง MCP"
            value={selectedTool}
            onChange={(e) => onSelectTool(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-xs text-foreground shadow-xs transition-colors focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring cursor-pointer"
          >
            {tools.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} — {t.description}
              </option>
            ))}
          </select>

          {paramKeys.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-xs text-muted-foreground font-medium block">
                คลิกเพิ่มพารามิเตอร์:
              </span>
              <div className="flex flex-wrap gap-1.5 items-center">
                {paramKeys.map((pk) => {
                  const isReq = requiredSet.has(pk);
                  const desc = String(schemaProps[pk]?.description || pk);
                  return (
                    <button
                      key={pk}
                      type="button"
                      title={desc}
                      onClick={() => onInsertParam(pk)}
                      className={
                        isReq
                          ? 'inline-flex items-center rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-mono font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer'
                          : 'inline-flex items-center rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs font-mono font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors cursor-pointer'
                      }
                    >
                      {pk}
                      {isReq ? ' *' : ''}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <Textarea
            id="mcp-tool-args"
            rows={6}
            value={rawArgs}
            onChange={(e) => onArgsChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="font-mono text-xs min-h-[140px]"
          />

          <div className="flex gap-2 flex-wrap">
            <Button
              type="button"
              variant={safety === 'destructive' ? 'destructive' : 'default'}
              onClick={onExecute}
              disabled={isPending}
            >
              <Play className="size-3.5 mr-1.5" />
              {isPending ? 'กำลังรัน...' : 'รันคำสั่ง (Execute)'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onResetTemplate}
              disabled={isPending}
            >
              <RefreshCw className="size-3.5 mr-1.5" />
              รีเซ็ต Template
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={isConfirmOpen} onOpenChange={onConfirmOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <div className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="size-5 text-destructive shrink-0" />
              <AlertDialogTitle>
                ยืนยันรันคำสั่งที่มีผลลบ/ถอนคืนข้อมูล ({selectedTool})
              </AlertDialogTitle>
            </div>
            <AlertDialogDescription>
              คำสั่งนี้ถูกทำเครื่องหมายเป็น Destructive กรุณาตรวจสอบ JSON Arguments ก่อนยืนยัน
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={onCancelConfirm}>ยกเลิก</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={onConfirmExecute}
            >
              ยืนยันรันคำสั่ง
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
