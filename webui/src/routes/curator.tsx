import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { CuratorPage } from '@/features/curator/curator-page';

export const curatorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/curator',
  component: CuratorPage,
});
