import { Minus, Plus, Crosshair, Eye, Focus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface GraphZoomHudProps {
  nodeCount: number;
  hiddenCount: number;
  focusRelatedOnly?: boolean;
  effectiveRelatedOnly?: boolean;
  onToggleFocusRelatedOnly?: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetZoom: () => void;
  onFocusSelected: () => void;
}

export function GraphZoomHud({
  nodeCount,
  hiddenCount,
  focusRelatedOnly = false,
  effectiveRelatedOnly = false,
  onToggleFocusRelatedOnly,
  zoom,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onFocusSelected,
}: GraphZoomHudProps) {
  return (
    <div className="flex items-center justify-between gap-2 flex-wrap mb-2 px-2.5 py-1.5 rounded-lg bg-card border border-border text-xs">
      <span className="text-muted-foreground truncate">
        {effectiveRelatedOnly
          ? `แสดงเฉพาะ ${nodeCount} โหนดที่เกี่ยวข้อง`
          : `แสดง ${nodeCount} โหนดสำคัญ`}
        {hiddenCount > 0 && (
          <span className="hidden sm:inline">
            {' '}
            {effectiveRelatedOnly
              ? `(ซ่อนโหนดที่ไม่เกี่ยวข้อง ${hiddenCount} รายการเพื่อให้อ่านง่าย)`
              : `(ซ่อนโหนดรอง ${hiddenCount} รายการเพื่อความอ่านง่าย — ใช้ช่องค้นหาเพื่อเจาะจง)`}
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
        {onToggleFocusRelatedOnly && (
          <Button
            id="graph-focus-related-toggle"
            type="button"
            size="sm"
            variant={focusRelatedOnly ? 'secondary' : 'outline'}
            onClick={onToggleFocusRelatedOnly}
            title={
              focusRelatedOnly
                ? 'แสดงโหนดทั้งหมดในกราฟ'
                : 'ซ่อนโหนดที่ไม่เกี่ยวข้อง แสดงเฉพาะเครือข่ายของจุดที่เลือก'
            }
            className="h-7 gap-1 px-2.5 text-[11px]"
          >
            {focusRelatedOnly ? (
              <>
                <Eye className="size-3" />
                <span>แสดงทั้งหมด</span>
              </>
            ) : (
              <>
                <Focus className="size-3" />
                <span>เฉพาะที่เกี่ยวข้อง</span>
              </>
            )}
          </Button>
        )}
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
