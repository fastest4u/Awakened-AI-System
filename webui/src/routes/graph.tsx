import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { Skeleton } from '@/components/ui/skeleton';

export function GraphStub() {
  return (
    <div className="space-y-6 p-6">
      <Skeleton className="h-14 w-full rounded-xl" />
      <Skeleton className="h-[520px] w-full rounded-xl" />
    </div>
  );
}

export const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/graph',
  component: GraphStub,
});
