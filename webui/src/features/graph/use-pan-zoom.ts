import { useState, useRef, useCallback } from 'react';

export interface PanOffset {
  x: number;
  y: number;
}

export interface UsePanZoomOptions {
  width: number;
  height: number;
}

export function usePanZoom({ width, height }: UsePanZoomOptions) {
  const [zoom, setZoom] = useState(1.0);
  const [pan, setPan] = useState<PanOffset>({ x: 0, y: 0 });

  const dragRef = useRef<{
    startX: number;
    startY: number;
    panX: number;
    panY: number;
    didDrag: boolean;
  } | null>(null);

  const wasDraggingRef = useRef(false);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))));
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
  }, []);

  const resetZoom = useCallback(() => {
    setZoom(1.0);
    setPan({ x: 0, y: 0 });
  }, []);

  const focusNode = useCallback(
    (targetPos?: { x: number; y: number } | null) => {
      if (!targetPos) return;
      setZoom(1.75);
      setPan({
        x: Math.round(targetPos.x - width / 2),
        y: Math.round(targetPos.y - height / 2),
      });
    },
    [width, height],
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      if (e.deltaY < 0) {
        zoomIn();
      } else {
        zoomOut();
      }
    },
    [zoomIn, zoomOut],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== undefined && e.button !== 0) return;
      wasDraggingRef.current = false;
      dragRef.current = {
        startX: Number(e.clientX || 0),
        startY: Number(e.clientY || 0),
        panX: pan.x,
        panY: pan.y,
        didDrag: false,
      };
    },
    [pan],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragRef.current) return;

      const rawDx = Number(e.clientX || 0) - dragRef.current.startX;
      const rawDy = Number(e.clientY || 0) - dragRef.current.startY;

      if (!dragRef.current.didDrag && Math.hypot(rawDx, rawDy) < 4) {
        return;
      }

      dragRef.current.didDrag = true;
      const dx = rawDx / zoom;
      const dy = rawDy / zoom;

      setPan({
        x: Math.round(dragRef.current.panX - dx),
        y: Math.round(dragRef.current.panY - dy),
      });
    },
    [zoom],
  );

  const handleMouseUp = useCallback(() => {
    wasDraggingRef.current = Boolean(
      dragRef.current && dragRef.current.didDrag,
    );
    dragRef.current = null;
  }, []);

  const handleMouseLeave = useCallback(() => {
    dragRef.current = null;
  }, []);

  // Compute SVG viewBox
  const vw = Math.round(width / zoom);
  const vh = Math.round(height / zoom);
  const vx = Math.round((width - vw) / 2 + pan.x);
  const vy = Math.round((height - vh) / 2 + pan.y);
  const viewBox = `${vx} ${vy} ${vw} ${vh}`;

  return {
    zoom,
    pan,
    setPan,
    zoomIn,
    zoomOut,
    resetZoom,
    focusNode,
    dragRef,
    wasDraggingRef,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleMouseLeave,
    viewBox,
  };
}
