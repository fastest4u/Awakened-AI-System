import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Zap, Sparkles, Layers, CheckCircle2, FileText, AlertCircle } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { auditQuery, invalidateProject } from '@/api/queries';
import { apiPost } from '@/api/client';
import { useOpenNote } from '@/hooks/use-open-note';
import type { AutoCurateReceipt } from '@/api/types';
import type { ChatMessage } from './curator-chat';
import { toast } from 'sonner';

export interface AutoCurateCardProps {
  projectRoot: string;
  onAddChatMessage?: (msg: ChatMessage) => void;
}

export function AutoCurateCard({
  projectRoot,
  onAddChatMessage,
}: AutoCurateCardProps) {
  const queryClient = useQueryClient();
  const openNote = useOpenNote();
  const { data: audit, isPending, isError, error } = useQuery(auditQuery(projectRoot));
  const [isRunning, setIsRunning] = useState(false);
  const [lastReceipt, setLastReceipt] = useState<AutoCurateReceipt | null>(null);

  const handleRunAutoCurate = async () => {
    if (isRunning || !projectRoot) return;
    setIsRunning(true);

    try {
      const data = await apiPost<AutoCurateReceipt>('/api/curator/auto-curate', {
        projectRoot,
        promoteCandidates: true,
        resolveDuplicates: true,
        expireStale: true,
      });

      const didMutate =
        (data.promoted && data.promoted.length > 0) ||
        (data.superseded && data.superseded.length > 0) ||
        (data.expired && data.expired.length > 0);

      if (didMutate) {
        await invalidateProject(queryClient, projectRoot);
      }

      const summaryMsg = didMutate
        ? `AI Auto-Curate เสร็จสิ้น! อนุมัติ Candidate ${data.promoted ? data.promoted.length : 0} รายการ, ยุบรวมความจำซ้ำ ${data.superseded ? data.superseded.length : 0} รายการ, หมดอายุ (Expired) ${data.expired ? data.expired.length : 0} รายการ (Health Score: ${data.beforeHealthScore} → ${data.afterHealthScore}/100)`
        : `คลังความจำสะอาดอยู่แล้ว (ไม่มีรายการรออนุมัติหรือซ้ำซ้อน) ไม่จำเป็นต้องเปิดเซสชันใหม่ (Health Score: ${data.afterHealthScore}/100)`;

      toast.success(summaryMsg);
      setLastReceipt(data);

      onAddChatMessage?.({
        id: `ac-${Date.now()}`,
        role: 'ai',
        text: summaryMsg,
        tools: didMutate
          ? [
              'memory_sessionStart',
              'memory_list',
              'memory_findDuplicates',
              'memory_checkStaleness',
              ...(data.promoted && data.promoted.length > 0 ? ['memory_promote'] : []),
              ...(data.superseded && data.superseded.length > 0 ? ['memory_supersede'] : []),
              ...(data.expired && data.expired.length > 0 ? ['memory_expire'] : []),
              'memory_sessionEnd',
            ]
          : ['memory_list', 'memory_findDuplicates', 'memory_checkStaleness'],
      });
    } catch (err: any) {
      const errMsg = `AI Auto-Curate ไม่สำเร็จ: ${err?.message || String(err)}`;
      toast.error(errMsg);
    } finally {
      setIsRunning(false);
    }
  };

  const recommendations = audit?.recommendations || [];
  const duplicateGroups = audit?.duplicateGroups || [];

  return (
    <Card className="flex flex-col h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <Zap className="size-4 text-amber-500" />
              <span>จัดการอัตโนมัติในคลิกเดียว (1-Click Auto-Curate)</span>
            </CardTitle>
            <CardDescription className="text-xs">
              อนุมัติรายการที่ผ่านเกณฑ์และยุบรวมความจำซ้ำให้อัตโนมัติ
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="default"
            size="sm"
            className="bg-emerald-600 hover:bg-emerald-700 text-white gap-1.5 h-8 text-xs shrink-0"
            onClick={handleRunAutoCurate}
            disabled={isRunning || !projectRoot}
          >
            <Sparkles className="size-3.5" />
            <span>{isRunning ? 'กำลังทำงาน...' : 'จัดระเบียบอัตโนมัติ'}</span>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex-1 space-y-4">
        {isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-16 rounded-lg" />
            <Skeleton className="h-16 rounded-lg" />
            <Skeleton className="h-24 rounded-lg" />
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>เกิดข้อผิดพลาดในการโหลดข้อมูลการตรวจสอบ</AlertTitle>
            <AlertDescription className="text-xs">
              {error instanceof Error ? error.message : 'ไม่สามารถดึงข้อมูล Curator Audit ได้'}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {/* Auto-Curate Receipt Banner (if executed) */}
            {lastReceipt && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                  <Sparkles className="size-3.5" />
                  <span>ผลการจัดระเบียบล่าสุด</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Health Score: {lastReceipt.beforeHealthScore} → {lastReceipt.afterHealthScore}/100
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline" className="text-[11px] font-normal bg-background/50">
                    อนุมัติ Candidate: {lastReceipt.promoted?.length || 0}
                  </Badge>
                  <Badge variant="outline" className="text-[11px] font-normal bg-background/50">
                    ยุบรวมความจำซ้ำ: {lastReceipt.superseded?.length || 0}
                  </Badge>
                  <Badge variant="outline" className="text-[11px] font-normal bg-background/50">
                    หมดอายุ: {lastReceipt.expired?.length || 0}
                  </Badge>
                </div>
              </div>
            )}

            {/* Recommendations List */}
            {recommendations.length > 0 && (
              <div className="space-y-2">
                {recommendations.map((r: any, idx: number) => (
                  <Alert key={idx} className="py-2.5">
                    <AlertTitle className="text-xs font-semibold">{r.title}</AlertTitle>
                    {r.description && (
                      <AlertDescription className="text-xs text-muted-foreground mt-0.5">
                        {r.description}
                      </AlertDescription>
                    )}
                  </Alert>
                ))}
              </div>
            )}

            <Separator />

            {/* Duplicate Groups */}
            <div>
              <h4 className="flex items-center gap-1.5 text-xs font-semibold text-foreground mb-2.5">
                <Layers className="size-3.5 text-[#6366f1]" />
                <span>รายการความจำที่ซ้ำกัน</span>
              </h4>

              {duplicateGroups.length === 0 ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground py-2">
                  <CheckCircle2 className="size-4 text-emerald-500" />
                  <span>ไม่พบความจำซ้ำ</span>
                </p>
              ) : (
                <div className="space-y-2.5">
                  {duplicateGroups.map((g, idx) => (
                    <Alert key={idx} className="py-2.5">
                      <AlertTitle className="text-xs font-medium">{g.title}</AlertTitle>
                      <AlertDescription>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                          <span className="text-muted-foreground text-[11px]">รายการหลัก:</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-6 px-2 text-xs font-mono"
                            title={g.keeperRecordId}
                            onClick={() => openNote(g.keeperRecordId)}
                          >
                            <FileText className="size-3 mr-1" />
                            <span>{g.keeperRecordId.slice(0, 14)}</span>
                          </Button>

                          <span className="text-muted-foreground text-[11px]">| ซ้ำ:</span>
                          {(g.duplicateRecordIds || []).map((dupId) => (
                            <Button
                              key={dupId}
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="h-6 px-2 text-xs font-mono"
                              title={dupId}
                              onClick={() => openNote(dupId)}
                            >
                              <span>{dupId.slice(0, 14)}</span>
                            </Button>
                          ))}
                        </div>
                      </AlertDescription>
                    </Alert>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
