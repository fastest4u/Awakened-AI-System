import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ShieldCheck,
  CheckCircle2,
  Share2,
  Landmark,
  Lightbulb,
  FileText,
  Code2,
  Clock,
} from 'lucide-react';
import { useOpenNote } from '@/hooks/use-open-note';
import { useNavigate } from '@tanstack/react-router';

export interface TriadItem {
  anchorMistakeId: string;
  mistakeTitle: string;
  relatedAdrs?: { recordId: string; title: string; score?: number }[];
  relatedAdrIds?: string[];
  relatedInsights?: { recordId: string; title: string; score?: number }[];
  relatedInsightIds?: string[];
  sharedContext?: string[];
}

export interface CausalTriadsCardProps {
  causalTriads?: TriadItem[] | null;
}

export function CausalTriadsCard({ causalTriads }: CausalTriadsCardProps) {
  const openNote = useOpenNote();
  const navigate = useNavigate();

  if (!causalTriads || causalTriads.length === 0) {
    return null;
  }

  const navigateToGraph = (nodeId?: string) => {
    navigate({
      to: '/graph',
      search: (prev: any) => ({
        ...prev,
        ...(nodeId ? { node: nodeId } : {}),
      }),
    });
  };

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4.5 text-[#10b981]" />
          <span>
            เส้นทางบทเรียนและทางแก้ (Causal Triads: บทเรียนในอดีต ➔ วิธีแก้ถาวร)
          </span>
        </CardTitle>
        <CardDescription>
          บันทึกข้อผิดพลาดในอดีตที่แก้ไขเสร็จแล้ว เชื่อมโยงกับบทเรียน (Insight) และสถาปัตยกรรม
          (ADR) อัตโนมัติเพื่อป้องกันปัญหาซ้ำ (IDF-Weighted)
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
          {causalTriads.slice(0, 6).map((triad) => {
            const adrItems =
              Array.isArray(triad.relatedAdrs) && triad.relatedAdrs.length > 0
                ? triad.relatedAdrs
                : (triad.relatedAdrIds || []).map((aid) => ({
                    recordId: aid,
                    title: `ADR ${String(aid).slice(0, 8)}`,
                  }));

            const insightItems =
              Array.isArray(triad.relatedInsights) &&
              triad.relatedInsights.length > 0
                ? triad.relatedInsights
                : (triad.relatedInsightIds || []).map((iid) => ({
                    recordId: iid,
                    title: `Insight ${String(iid).slice(0, 8)}`,
                  }));

            const visibleAdrs = adrItems.slice(0, 3);
            const visibleInsights = insightItems.slice(0, 3);
            const hiddenCount =
              Math.max(0, adrItems.length - visibleAdrs.length) +
              Math.max(0, insightItems.length - visibleInsights.length);

            const sharedContext = Array.isArray(triad.sharedContext)
              ? triad.sharedContext
              : [];

            return (
              <div
                key={triad.anchorMistakeId}
                className="p-3.5 rounded-xl border border-border/80 bg-card/60 hover:border-[#10b981]/40 flex flex-col gap-2.5 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <Badge
                    variant="outline"
                    className="gap-1 border-[#10b981]/35 bg-[#10b981]/10 text-[#059669] dark:text-[#34d399]"
                  >
                    <CheckCircle2 className="size-3" />
                    <span>บทเรียนในอดีต (แก้แล้ว)</span>
                  </Badge>
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2 text-xs"
                      onClick={() => openNote(triad.anchorMistakeId)}
                    >
                      อ่าน
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs gap-1"
                      onClick={() => navigateToGraph(triad.anchorMistakeId)}
                    >
                      <Share2 className="size-3" />
                      <span>ดูในกราฟ</span>
                    </Button>
                  </div>
                </div>

                <div className="text-xs font-bold leading-snug line-clamp-2">
                  {triad.mistakeTitle}
                </div>

                <div className="flex flex-col gap-1.5">
                  {visibleAdrs.map((adr) => (
                    <Button
                      key={adr.recordId}
                      size="sm"
                      variant="outline"
                      title={`ADR: ${adr.title}`}
                      className="justify-start text-left h-auto py-1 px-2 text-xs font-normal"
                      onClick={() => openNote(adr.recordId)}
                    >
                      <Landmark className="size-3 shrink-0 text-[#6366f1] mr-1.5" />
                      <span className="truncate">{adr.title}</span>
                    </Button>
                  ))}

                  {visibleInsights.map((ins) => (
                    <Button
                      key={ins.recordId}
                      size="sm"
                      variant="outline"
                      title={`Insight: ${ins.title}`}
                      className="justify-start text-left h-auto py-1 px-2 text-xs font-normal"
                      onClick={() => openNote(ins.recordId)}
                    >
                      <Lightbulb className="size-3 shrink-0 text-[#10b981] mr-1.5" />
                      <span className="truncate">{ins.title}</span>
                    </Button>
                  ))}

                  {hiddenCount > 0 && (
                    <button
                      type="button"
                      onClick={() => navigateToGraph(triad.anchorMistakeId)}
                      className="text-[11px] text-muted-foreground hover:text-foreground text-left pl-1 cursor-pointer"
                    >
                      + อีก {hiddenCount} รายการที่เชื่อมโยง (คลิกดูทั้งหมดในกราฟ)
                    </button>
                  )}
                </div>

                {sharedContext.length > 0 && (
                  <div className="flex flex-wrap gap-1 pt-1 mt-auto">
                    {sharedContext.slice(0, 5).map((ctx) => {
                      if (ctx.startsWith('file:')) {
                        const fp = ctx.slice(5);
                        const short = fp.split('/').pop() || fp;
                        return (
                          <Badge
                            key={ctx}
                            variant="outline"
                            title={`${fp} (คลิกเพื่อดูในกราฟ)`}
                            className="text-[10px] px-1.5 py-0 h-5 cursor-pointer gap-1 hover:bg-accent"
                            onClick={() => navigateToGraph(ctx)}
                          >
                            <FileText className="size-2.5 text-[#10b981]" />
                            <span className="max-w-[100px] truncate">{short}</span>
                          </Badge>
                        );
                      }
                      if (ctx.startsWith('symbol:')) {
                        const sym = ctx.slice(7);
                        return (
                          <Badge
                            key={ctx}
                            variant="outline"
                            title={`Symbol: ${sym} (คลิกเพื่อดูในกราฟ)`}
                            className="text-[10px] px-1.5 py-0 h-5 cursor-pointer gap-1 hover:bg-accent"
                            onClick={() => navigateToGraph(ctx)}
                          >
                            <Code2 className="size-2.5 text-[#f59e0b]" />
                            <span className="max-w-[100px] truncate">{sym}</span>
                          </Badge>
                        );
                      }
                      if (ctx.startsWith('session:')) {
                        const sid = ctx.slice(8);
                        return (
                          <Badge
                            key={ctx}
                            variant="outline"
                            title={`Session: ${sid} (คลิกเพื่อดูในกราฟ)`}
                            className="text-[10px] px-1.5 py-0 h-5 cursor-pointer gap-1 hover:bg-accent"
                            onClick={() => navigateToGraph(ctx)}
                          >
                            <Clock className="size-2.5 text-muted-foreground" />
                            <span>เซสชัน #{sid.slice(0, 8)}</span>
                          </Badge>
                        );
                      }
                      return (
                        <Badge key={ctx} variant="outline" className="text-[10px]">
                          {ctx}
                        </Badge>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
