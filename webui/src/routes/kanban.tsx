import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { Skeleton } from '@/components/ui/skeleton';

export function KanbanStub() {
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <input
          id="kanban-search-input"
          type="text"
          placeholder="พิมพ์ค้นหาความจำ ชื่อไฟล์ หรือฟังก์ชัน... (Ctrl+K)"
          className="h-9 w-full max-w-sm rounded-md border border-input bg-card px-3 text-sm shadow-xs focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    </div>
  );
}

export const kanbanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kanban',
  component: KanbanStub,
});
