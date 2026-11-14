import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { KanbanPage } from '@/features/kanban/kanban-page';

export const kanbanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/kanban',
  component: KanbanPage,
});
