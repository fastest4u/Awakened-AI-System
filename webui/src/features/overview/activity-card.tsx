import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { TrendingUp } from 'lucide-react';
import {
  ComposedChart,
  Area,
  Bar,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '@/components/ui/chart';

export interface ActivityPoint {
  label: string;
  notes: number;
  verified: number;
  sessions?: number;
}

export interface ActivityCardProps {
  activitySeries?: ActivityPoint[] | null;
}

const chartConfig: ChartConfig = {
  notes: {
    label: 'ความจำทั้งหมด',
    color: '#6366f1',
  },
  verified: {
    label: 'ยืนยันแล้ว',
    color: '#10b981',
  },
};

export function ActivityCard({ activitySeries }: ActivityCardProps) {
  const data =
    Array.isArray(activitySeries) && activitySeries.length > 0
      ? activitySeries
      : [
          { label: 'S-1', notes: 0, verified: 0 },
          { label: 'Now', notes: 0, verified: 0 },
        ];

  return (
    <Card className="h-full flex flex-col justify-between">
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <TrendingUp className="size-4.5 text-[#6366f1]" />
            <span>แนวโน้มการเติบโตของความจำ (Activity Trend)</span>
          </CardTitle>
          <Badge variant="default">Real-time</Badge>
        </div>
        <CardDescription>
          กราฟแสดงจำนวนความจำสะสม (สีม่วง) และที่ยืนยันแล้ว (แท่งสีเขียว)
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-2">
        <div
          className="w-full h-[155px]"
          ref={(parent) => {
            if (parent) {
              const el = parent.querySelector(
                '.recharts-responsive-container',
              ) as HTMLElement | null;
              if (el) {
                const orig = el.getBoundingClientRect.bind(el);
                el.getBoundingClientRect = () => {
                  const r = orig();
                  return r.width === 0 && r.height === 0
                    ? {
                        width: 320,
                        height: 155,
                        top: 0,
                        left: 0,
                        bottom: 155,
                        right: 320,
                        x: 0,
                        y: 0,
                        toJSON: () => {},
                      }
                    : r;
                };
              }
            }
          }}
        >
          <ChartContainer
            config={chartConfig}
            initialDimension={{ width: 320, height: 155 }}
            className="h-[155px] w-full aspect-auto"
          >
            <ComposedChart
              data={data}
              margin={{ top: 8, right: 12, left: -20, bottom: 0 }}
            >
              <defs>
                <linearGradient id="areaGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                domain={[0, 'auto']}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area
                type="monotone"
                dataKey="notes"
                fill="url(#areaGradient)"
                stroke="#6366f1"
                strokeWidth={2}
              />
              <Bar
                dataKey="verified"
                barSize={12}
                fill="#10b981"
                radius={[3, 3, 0, 0]}
                opacity={0.85}
              />
            </ComposedChart>
          </ChartContainer>
        </div>
      </CardContent>
    </Card>
  );
}
