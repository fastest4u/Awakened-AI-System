import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { GraphPage } from '@/features/graph/graph-page';

export const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/graph',
  component: GraphPage,
});
