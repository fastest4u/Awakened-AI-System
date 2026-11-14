import { createRoute, redirect } from '@tanstack/react-router';
import { rootRoute } from './__root';

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/overview',
      search: (prev: any) => ({ ...prev, ...search }),
    });
  },
});
