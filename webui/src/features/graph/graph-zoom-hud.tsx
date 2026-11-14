import { Minus, Plus, Crosshair } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface GraphZoomHudProps {
  nodeCount: number;
  hiddenCount: number;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFocusSelected: () => void;
}

export function GraphZoomHud({
  nodeCount,
  hiddenCount,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFocusSelected,
}: GraphZoomHudProps) {
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap mb-2 px-2.5 py-1.5 rounded-lg bg-card border border-border text-xs">
      <span className="text-muted-foreground truncate">
        แสดง {nodeCount} โหนดสำคัญ
        {hiddenCount > 0 && (
          <span className="hidden sm:inline">
            {' '}
            (ซ่อนโหนดรอง {hiddenCount} รายการเพื่อความอ่านง่าย — ใช้ช่องค้นหาเพื่อเจาะจง)
          </span>
        )}
      </span>

      <div id="graph-zoom-hud" className="flex items-center gap-1.5 shrink-0">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onZoomOut}
          title="ซูมออก"
          className="h-7 w-7 p-0"
        >
          <Minus className="size-3" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onResetZoom}
          title="รีเซ็ตมุมมอง 100%"
          className="h-7 px-2 text-[11px] font-medium"
        >
          {Math.round(zoom * 100)}%
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onZoomIn}
          title="ซูมเข้า"
          className="h-7 w-7 p-0"
        >
          <Plus className="size-3" />
        </Button>
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={onFocusSelected}
          title="ซูมโฟกัสจุดที่เลือก"
          className="h-7 gap-1 px-2.5 text-[11px]"
        >
          <Crosshair className="size-3" />
          <span>ซูมดูจุดที่เลือก</span>
        </Button>
      </div>
    </div>
  );
}
