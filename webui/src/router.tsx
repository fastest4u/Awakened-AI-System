import {
  createRouter,
  createBrowserHistory,
  type RouterHistory,
} from '@tanstack/react-router';
import { rootRoute } from './routes/__root';
import { indexRoute } from './routes/index';
import { overviewRoute } from './routes/overview';
import { kanbanRoute } from './routes/kanban';
import { graphRoute } from './routes/graph';
import { curatorRoute } from './routes/curator';
import { mcpRoute } from './routes/mcp';
import { legacyHashToHref } from './lib/search';

export const routeTree = rootRoute.addChildren([
  indexRoute,
  overviewRoute,
  kanbanRoute,
  graphRoute,
  curatorRoute,
  mcpRoute,
]);

export function createAppRouter(history?: RouterHistory) {
  const router = createRouter({
    routeTree,
    history: history ?? createBrowserHistory(),
    defaultPreload: 'intent',
    defaultViewTransition: true,
  });

  if (typeof window !== 'undefined' && window.location?.hash) {
    const legacyHref = legacyHashToHref(window.location.hash);
    if (legacyHref) {
      router.history.replace(legacyHref);
    }
  }

  return router;
}

export type AppRouter = ReturnType<typeof createAppRouter>;

declare module '@tanstack/react-router' {
  interface Register {
    router: AppRouter;
  }
}
