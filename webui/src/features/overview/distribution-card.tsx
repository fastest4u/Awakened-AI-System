import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  PieChart as PieChartIcon,
  Landmark,
  Lightbulb,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { kindDistribution } from '@/lib/overview-math';
import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

export interface DistributionCardProps {
  byKind?: Record<string, number> | null;
}

const KIND_META = {
  adr: {
    label: 'ADR (การตัดสินใจ)',
    icon: Landmark,
    color: '#6366f1',
  },
  insight: {
    label: 'Insight (บทเรียน)',
    icon: Lightbulb,
    color: '#10b981',
  },
  mistake: {
    label: 'Mistake (ข้อควรระวัง)',
    icon: AlertTriangle,
    color: '#f59e0b',
  },
  'session-log': {
    label: 'Session Log (ประวัติ)',
    icon: FileText,
    color: '#38bdf8',
  },
} as const;

export function DistributionCard({ byKind }: DistributionCardProps) {
  const items = kindDistribution(byKind);
  const total = items.reduce((acc, it) => acc + it.count, 0);

  const chartData =
    total > 0
      ? items
          .filter((it) => it.count > 0)
          .map((it) => ({
            name: KIND_META[it.key].label,
            value: it.count,
            color: KIND_META[it.key].color,
          }))
      : [{ name: 'Empty', value: 1, color: 'hsl(var(--muted))' }];

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <PieChartIcon className="size-4.5 text-[#10b981]" />
            <span>สัดส่วนประเภทความจำ (Distribution)</span>
          </CardTitle>
          <Badge variant="secondary">รวม {total} รายการ</Badge>
        </div>
        <CardDescription>
          แยกตามหมวดหมู่ ADR, Insight, Mistake และ Session Log
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col sm:flex-row items-center gap-4">
          <div className="w-[120px] h-[120px] shrink-0 relative flex items-center justify-center">
            <ResponsiveContainer
              width={120}
              height={120}
              minWidth={0}
              minHeight={0}
              initialDimension={{ width: 120, height: 120 }}
            >
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={36}
                  outerRadius={52}
                  paddingAngle={total > 0 ? 3 : 0}
                  dataKey="value"
                  strokeWidth={1}
                  stroke="hsl(var(--card))"
                >
                  {chartData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={entry.color} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <span className="text-sm font-bold text-foreground">{total}</span>
              <span className="text-[9px] text-muted-foreground">รายการ</span>
            </div>
          </div>

          <div className="flex-1 w-full flex flex-col gap-2.5">
            {items.map((it) => {
              const meta = KIND_META[it.key];
              const Icon = meta.icon;
              return (
                <div key={it.key} className="space-y-1">
                  <div className="flex justify-between items-center text-xs">
                    <span className="inline-flex items-center gap-1.5 font-medium">
                      <Icon className="size-3.5" style={{ color: meta.color }} />
                      <span>{meta.label}</span>
                    </span>
                    <span className="text-muted-foreground font-semibold">
                      {it.count} ({it.percent}%)
                    </span>
                  </div>
                  <Progress
                    value={it.percent}
                    className="h-1.5 bg-secondary"
                  />
                </div>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
