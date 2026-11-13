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
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

export interface ActivityPoint {
  label: string;
  notes: number;
  verified: number;
  sessions?: number;
}

export interface ActivityCardProps {
  activitySeries?: ActivityPoint[] | null;
}

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
        <div className="w-full h-[155px]">
          <ResponsiveContainer
            width="100%"
            height={155}
            minWidth={0}
            minHeight={0}
            initialDimension={{ width: 320, height: 155 }}
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
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                domain={[0, 'auto']}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="rounded-lg border bg-popover px-2.5 py-1.5 text-xs shadow-md">
                      <p className="font-semibold text-popover-foreground mb-1">
                        {label}
                      </p>
                      {payload.map((item, idx) => (
                        <div
                          key={`tt-${idx}`}
                          className="flex items-center justify-between gap-3 text-muted-foreground"
                        >
                          <span
                            className="inline-block size-2 rounded-full"
                            style={{ backgroundColor: item.color }}
                          />
                          <span>
                            {item.dataKey === 'notes'
                              ? 'ความจำทั้งหมด'
                              : 'ยืนยันแล้ว'}
                            :
                          </span>
                          <span className="font-medium text-foreground">
                            {item.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                }}
              />
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
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
