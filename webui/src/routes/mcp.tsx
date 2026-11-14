import { createRoute } from '@tanstack/react-router';
import { rootRoute } from './__root';
import { McpPage } from '@/features/mcp/mcp-page';

export const mcpRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/mcp',
  component: McpPage,
});
