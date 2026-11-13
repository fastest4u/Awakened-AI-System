import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { OverviewPage } from '@/features/overview/overview-page';

export const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/overview',
  component: OverviewPage,
});
