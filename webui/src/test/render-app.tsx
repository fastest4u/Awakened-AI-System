import { render, type RenderResult } from '@testing-library/react';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { QueryClient } from '@tanstack/react-query';
import { vi } from 'vitest';
import { createAppRouter, type AppRouter } from '@/router';
import { AppProviders } from '@/providers/app-providers';
import { resetBootstrap } from '@/api/client';
import type { ProjectSummary } from '@/api/types';

export interface StubFetchCall {
  url: string;
  options?: RequestInit;
}

export interface RenderAppOptions {
  initialUrl?: string;
  defaultProjectRoot?: string;
  projects?: ProjectSummary[];
  fetchHandler?: (
    url: string,
    options?: RequestInit,
  ) =>
    | Promise<Response | null | undefined>
    | Response
    | null
    | undefined;
  queryClient?: QueryClient;
}

export interface RenderAppResult extends RenderResult {
  router: AppRouter;
  queryClient: QueryClient;
  history: ReturnType<typeof createMemoryHistory>;
  fetchCalls: StubFetchCall[];
}

function makeJsonResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function renderApp(options: RenderAppOptions = {}): RenderAppResult {
  const {
    initialUrl = '/overview',
    defaultProjectRoot = 'C:\\default',
    projects,
    fetchHandler,
  } = options;

  resetBootstrap();

  // Setup default meta tags
  document.head
    .querySelectorAll('meta[name^="pm-"]')
    .forEach((el) => el.remove());

  const metaToken = document.createElement('meta');
  metaToken.name = 'pm-csrf-token';
  metaToken.content = 'test-csrf-token';
  document.head.appendChild(metaToken);

  const metaProj = document.createElement('meta');
  metaProj.name = 'pm-default-project';
  metaProj.content = defaultProjectRoot;
  document.head.appendChild(metaProj);

  const fetchCalls: StubFetchCall[] = [];

  const defaultProjects: ProjectSummary[] = projects ?? [
    {
      projectRoot: defaultProjectRoot,
      name: 'default',
      initialized: true,
      mode: 'active',
      productionReady: true,
    },
  ];

  const stubFetch = vi.fn().mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchCalls.push({ url, options: init });

      if (fetchHandler) {
        const customRes = await fetchHandler(url, init);
        if (customRes) return customRes;
      }

      if (url === '/api/bootstrap') {
        return makeJsonResponse({
          ok: true,
          csrfToken: 'test-csrf-token',
          defaultProjectRoot,
        });
      }

      if (url === '/api/projects') {
        return makeJsonResponse({
          ok: true,
          defaultProjectRoot,
          projects: defaultProjects,
        });
      }

      if (url.startsWith('/api/overview')) {
        return makeJsonResponse({
          ok: true,
          projectRoot: defaultProjectRoot,
          projectName: 'default',
          status: 'active',
          lifecycle: { sessions: [], latestCheckpoint: null },
          audit: {
            healthScore: 100,
            counts: {},
            recommendations: [],
            duplicateGroups: [],
          },
          causalTriads: [],
          analytics: { byStatus: {}, byKind: {}, activitySeries: [] },
        });
      }

      if (url.startsWith('/api/notes')) {
        return makeJsonResponse({
          ok: true,
          projectRoot: defaultProjectRoot,
          items: [],
        });
      }

      if (url.startsWith('/api/graph')) {
        return makeJsonResponse({
          ok: true,
          projectRoot: defaultProjectRoot,
          nodes: [],
          edges: [],
          causalTriads: [],
          stats: {
            sessionNodes: 0,
            noteNodes: 0,
            fileNodes: 0,
            symbolNodes: 0,
            edgeCount: 0,
          },
        });
      }

      if (url.startsWith('/api/curator/audit')) {
        return makeJsonResponse({
          projectRoot: defaultProjectRoot,
          healthScore: 100,
          counts: {},
          recommendations: [],
          duplicateGroups: [],
          staleItems: [],
        });
      }

      if (url.startsWith('/api/mcp/tools')) {
        return makeJsonResponse({
          ok: true,
          tools: [],
        });
      }

      return makeJsonResponse({ ok: true });
    },
  );

  vi.stubGlobal('fetch', stubFetch);

  const queryClient =
    options.queryClient ??
    new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: 15_000,
        },
      },
    });

  // Pre-seed projects query data so project-switcher renders immediately
  queryClient.setQueryData(['pm-v2', 'projects'], {
    ok: true,
    defaultProjectRoot,
    projects: defaultProjects,
  });

  const history = createMemoryHistory({
    initialEntries: [initialUrl],
  });

  const router = createAppRouter(history);

  const rendered = render(
    <AppProviders
      queryClient={queryClient}
      defaultProjectRoot={defaultProjectRoot}
    >
      <RouterProvider router={router} />
    </AppProviders>,
  );

  return {
    ...rendered,
    router,
    queryClient,
    history,
    fetchCalls,
  };
}
