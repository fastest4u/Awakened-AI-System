import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { Skeleton } from '@/components/ui/skeleton';

export function McpStub() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
      <Skeleton className="h-[480px] rounded-xl" />
      <Skeleton className="h-[480px] rounded-xl" />
    </div>
  );
}

export const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mcp',
  component: McpStub,
});
