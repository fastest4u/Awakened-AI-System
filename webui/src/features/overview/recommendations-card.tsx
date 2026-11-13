import { useState } from 'react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  Sparkles,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';

export interface RecommendationItem {
  title: string;
  description: string;
  priority?: 'high' | 'medium' | 'low' | string;
}

export interface RecommendationsCardProps {
  recommendations?: RecommendationItem[] | null;
  statusInfo?: {
    projectId?: string;
    vaultId?: string;
    releaseId?: string;
    generation?: number;
  } | null;
  latestCheckpoint?: unknown;
}

export function RecommendationsCard({
  recommendations,
  statusInfo,
  latestCheckpoint,
}: RecommendationsCardProps) {
  const navigate = useNavigate();
  const [showTechDetails, setShowTechDetails] = useState(false);

  const recList = Array.isArray(recommendations) ? recommendations : [];

  return (
    <Card className="h-full flex flex-col justify-between">
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
      <CardContent className="space-y-3">
        {recList.length === 0 ? (
          <Alert>
            <AlertTitle className="flex items-center gap-1.5 text-sm">
              <CheckCircle2 className="size-4 text-[#10b981]" />
              <span>คลังความจำสะอาดสมบูรณ์</span>
            </AlertTitle>
            <AlertDescription className="text-xs">
              ไม่มีรายการค้างอนุมัติหรือความจำซ้ำซ้อนในขณะนี้
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2.5 max-h-[280px] overflow-y-auto pr-1">
            {recList.map((rec, i) => (
              <Alert key={i} className="py-2.5">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <AlertTitle className="text-xs font-semibold leading-snug">
                    {rec.title}
                  </AlertTitle>
                  <Badge
                    variant={rec.priority === 'high' ? 'destructive' : 'warning'}
                    className="text-[10px] uppercase font-bold"
                  >
                    {rec.priority || 'medium'}
                  </Badge>
                </div>
                <AlertDescription className="text-xs text-muted-foreground">
                  {rec.description}
                </AlertDescription>
              </Alert>
            ))}
          </div>
        )}

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
