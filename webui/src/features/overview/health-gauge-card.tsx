import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Gauge } from 'lucide-react';
import {
  healthTone,
  gaugePercents,
  calculateGaugeDashOffset,
} from '@/lib/overview-math';

export interface HealthGaugeCardProps {
  score?: number | null;
  verified?: number;
  candidates?: number;
  conflicts?: number;
}

export function HealthGaugeCard({
  score = 0,
  verified = 0,
  candidates = 0,
  conflicts = 0,
}: HealthGaugeCardProps) {
  const numScore = Math.min(100, Math.max(0, Number(score) || 0));
  const toneInfo = healthTone(numScore);
  const percents = gaugePercents({ verified, candidates, conflicts });
  const { circumference, dashOffset } = calculateGaugeDashOffset(numScore, 58);

  const badgeVariant =
    numScore >= 85 ? 'success' : numScore >= 65 ? 'warning' : 'destructive';

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4.5 text-[#6366f1]" />
            <span>สุขภาพคลังความจำ (Health Gauge)</span>
          </CardTitle>
          <Badge variant={badgeVariant}>{toneInfo.label}</Badge>
        </div>
        <CardDescription>
          ดัชนีความพร้อมและความน่าเชื่อถือของความจำในโปรเจกต์
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row items-center gap-6">
          <div className="relative shrink-0 flex items-center justify-center">
            <svg width="148" height="148" viewBox="0 0 148 148" className="overflow-visible">
              <circle
                cx="74"
                cy="74"
                r="58"
                fill="none"
                stroke="hsl(var(--secondary))"
                strokeWidth="12"
              />
              <circle
                cx="74"
                cy="74"
                r="58"
                fill="none"
                stroke={toneInfo.color}
                strokeWidth="12"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 74 74)"
                className="transition-all duration-500 ease-out"
              />
              <text
                x="74"
                y="70"
                textAnchor="middle"
                fill="currentColor"
                className="text-2xl font-extrabold fill-foreground"
                dominantBaseline="central"
              >
                {numScore}
              </text>
              <text
                x="74"
                y="94"
                textAnchor="middle"
                className="text-[11px] fill-muted-foreground"
                dominantBaseline="central"
              >
                คะแนนเต็ม 100
              </text>
            </svg>
          </div>

          <div className="flex-1 w-full flex flex-col gap-3 min-w-[150px]">
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Verified (ยืนยันแล้ว)</span>
                <strong className="text-[#10b981] font-semibold">
                  {verified} ({percents.verified}%)
                </strong>
              </div>
              <Progress
                value={percents.verified}
                className="h-2 bg-secondary"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Candidates (รออนุมัติ)</span>
                <strong className="text-[#f59e0b] font-semibold">
                  {candidates} ({percents.candidates}%)
                </strong>
              </div>
              <Progress
                value={percents.candidates}
                className="h-2 bg-secondary"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-muted-foreground">Conflicts (ขัดแย้ง/ซ้ำ)</span>
                <strong className="text-[#ef4444] font-semibold">
                  {conflicts} ({percents.conflicts}%)
                </strong>
              </div>
              <Progress
                value={percents.conflicts}
                className="h-2 bg-secondary"
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
