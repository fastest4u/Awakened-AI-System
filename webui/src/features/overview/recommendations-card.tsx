import { useState, type ReactNode } from 'react';
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
  Sparkles,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Info,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import type { OverviewStatusInfo } from '@/api/types';

export interface RecommendationItem {
  id?: string;
  title: string;
  description: string;
  priority?: 'high' | 'medium' | 'low' | string;
  category?: 'duplicates' | 'promotion' | 'staleness' | 'conflicts' | 'healthy' | string;
  actionType?: string;
}

export interface RecommendationsCardProps {
  recommendations?: RecommendationItem[] | null;
  statusInfo?: OverviewStatusInfo | null;
  latestCheckpoint?: unknown;
}

interface RecommendationTone {
  containerClass: string;
  icon: ReactNode;
  badgeVariant: 'outline' | 'secondary';
  badgeClass: string;
  label: string;
}

function resolveRecommendationTone(
  rec: Pick<RecommendationItem, 'id' | 'priority' | 'category'>,
): RecommendationTone {
  if (rec.category === 'healthy' || rec.id === 'rec-vault-healthy') {
    return {
      containerClass: 'border-[#10b981]/30 bg-[#10b981]/[0.06]',
      icon: <CheckCircle2 className="size-4 text-[#10b981] shrink-0 mt-0.5" />,
      badgeVariant: 'outline',
      badgeClass: 'border-[#10b981]/35 bg-[#10b981]/12 text-[#059669] dark:text-[#34d399]',
      label: 'ปกติ (Healthy)',
    };
  }
  if (rec.priority === 'high') {
    return {
      containerClass: 'border-[#ef4444]/30 bg-[#ef4444]/[0.05]',
      icon: <AlertTriangle className="size-4 text-[#ef4444] shrink-0 mt-0.5" />,
      badgeVariant: 'outline',
      badgeClass: 'border-[#ef4444]/35 bg-[#ef4444]/12 text-[#dc2626] dark:text-[#f87171]',
      label: 'สำคัญมาก (High)',
    };
  }
  if (rec.priority === 'low') {
    return {
      containerClass: 'border-border/80 bg-muted/25',
      icon: <Info className="size-4 text-[#38bdf8] shrink-0 mt-0.5" />,
      badgeVariant: 'secondary',
      badgeClass: 'text-muted-foreground',
      label: 'ทั่วไป (Low)',
    };
  }
  return {
    containerClass: 'border-[#f59e0b]/30 bg-[#f59e0b]/[0.05]',
    icon: <Sparkles className="size-4 text-[#f59e0b] shrink-0 mt-0.5" />,
    badgeVariant: 'outline',
    badgeClass: 'border-[#f59e0b]/35 bg-[#f59e0b]/12 text-[#d97706] dark:text-[#fbbf24]',
    label: 'แนะนำ (Medium)',
  };
}

export function RecommendationsCard({
  recommendations,
  statusInfo,
  latestCheckpoint,
}: RecommendationsCardProps) {
  const navigate = useNavigate();
  const [showTechDetails, setShowTechDetails] = useState(false);

  const recList = Array.isArray(recommendations) ? recommendations : [];
  const itemsToRender: RecommendationItem[] =
    recList.length > 0
      ? recList
      : [
          {
            id: 'rec-vault-healthy',
            category: 'healthy',
            priority: 'low',
            title: 'คลังความจำสะอาดสมบูรณ์',
            description: 'ไม่มีรายการค้างอนุมัติหรือความจำซ้ำซ้อนในขณะนี้',
          },
        ];

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="size-4.5 text-[#f59e0b]" />
            <span>คำแนะนำอัจฉริยะ (AI Curator Insights)</span>
          </CardTitle>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              navigate({
                to: '/curator',
                search: (prev: any) => ({ ...prev }),
              })
            }
          >
            <span>เปิด AI Studio</span>
            <ArrowRight className="size-3" />
          </Button>
        </div>
        <CardDescription>
          สรุปสิ่งที่ควรทำเพื่อรักษาความสะอาดของคลังความจำ
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="space-y-2.5 max-h-[280px] overflow-y-auto pr-1">
          {itemsToRender.map((rec, i) => {
            const tone = resolveRecommendationTone(rec);
            return (
              <div
                key={rec.id ?? i}
                data-slot="recommendation-item"
                className={`rounded-xl border px-3.5 py-3 transition-colors ${tone.containerClass}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0 flex-1">
                    {tone.icon}
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="text-xs font-semibold text-foreground leading-snug break-words">
                        {rec.title}
                      </p>
                      {rec.description && (
                        <p className="text-xs text-muted-foreground leading-relaxed break-words">
                          {rec.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <Badge
                    variant={tone.badgeVariant}
                    className={`shrink-0 text-[10px] font-semibold ${tone.badgeClass}`}
                  >
                    {tone.label}
                  </Badge>
                </div>
              </div>
            );
          })}
        </div>

        <div className="pt-2 border-t border-border/50">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground hover:text-foreground h-8 px-2 gap-1.5"
            onClick={() => setShowTechDetails((prev) => !prev)}
          >
            {showTechDetails ? (
              <ChevronUp className="size-3.5" />
            ) : (
              <ChevronDown className="size-3.5" />
            )}
            <span>
              {showTechDetails
                ? 'ซ่อนข้อมูลเทคนิค (Hide Vault Metadata)'
                : 'ดูข้อมูลเทคนิค (Vault Identity & Checkpoint)'}
            </span>
          </Button>

          {showTechDetails && (
            <pre className="mt-2 p-3 rounded-lg border bg-muted/40 font-mono text-[11px] overflow-x-auto text-muted-foreground leading-relaxed">
              {JSON.stringify(
                {
                  projectId: statusInfo?.projectId,
                  vaultId: statusInfo?.vaultId,
                  releaseId: statusInfo?.releaseId,
                  latestCheckpoint: latestCheckpoint ?? null,
                },
                null,
                2,
              )}
            </pre>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
