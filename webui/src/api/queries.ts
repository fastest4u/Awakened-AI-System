import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { apiGet } from './client';
import type {
  ProjectsResponse,
  OverviewResponse,
  NoteItem,
  NoteDetailResponse,
  GraphResponse,
  CuratorAudit,
  McpToolDefinition,
} from './types';

export const pmKeys = {
  projects: () => ['pm-v2', 'projects'] as const,
  project: (p: string) => ['pm-v2', p] as const,
  overview: (p: string) => ['pm-v2', p, 'overview'] as const,
  notes: (p: string, f?: { query?: string; kind?: string; status?: string }) =>
    ['pm-v2', p, 'notes', f] as const,
  note: (p: string, id: string) => ['pm-v2', p, 'note', id] as const,
  graph: (p: string) => ['pm-v2', p, 'graph'] as const,
  audit: (p: string) => ['pm-v2', p, 'audit'] as const,
  mcpTools: () => ['pm-v2', 'mcp-tools'] as const,
};

export function projectsQuery() {
  return queryOptions({
    queryKey: pmKeys.projects(),
    queryFn: () => apiGet<ProjectsResponse>('/api/projects'),
    staleTime: 15_000,
  });
}

export function overviewQuery(project: string) {
  return queryOptions({
    queryKey: pmKeys.overview(project),
    queryFn: () => apiGet<OverviewResponse>('/api/overview', { project }),
    staleTime: 15_000,
    enabled: Boolean(project),
  });
}

export function notesQuery(
  project: string,
  filter?: { query?: string; kind?: string; status?: string },
) {
  return queryOptions({
    queryKey: pmKeys.notes(project, filter),
    queryFn: () =>
      apiGet<{ ok: boolean; projectRoot: string; items: NoteItem[] }>('/api/notes', {
        project,
        query: filter?.query,
        kind: filter?.kind,
        status: filter?.status,
      }),
    staleTime: 15_000,
    enabled: Boolean(project),
  });
}

export function noteQuery(project: string, id: string) {
  return queryOptions({
    queryKey: pmKeys.note(project, id),
    queryFn: () =>
      apiGet<NoteDetailResponse>(`/api/notes/${encodeURIComponent(id)}`, { project }),
    staleTime: 15_000,
    enabled: Boolean(project && id),
  });
}

export function graphQuery(project: string) {
  return queryOptions({
    queryKey: pmKeys.graph(project),
    queryFn: () => apiGet<GraphResponse>('/api/graph', { project }),
    staleTime: 15_000,
    enabled: Boolean(project),
  });
}

export function auditQuery(project: string) {
  return queryOptions({
    queryKey: pmKeys.audit(project),
    queryFn: () => apiGet<CuratorAudit>('/api/curator/audit', { project }),
    staleTime: 15_000,
    enabled: Boolean(project),
  });
}

export function mcpToolsQuery() {
  return queryOptions({
    queryKey: pmKeys.mcpTools(),
    queryFn: () =>
      apiGet<{ ok: boolean; tools: McpToolDefinition[] }>('/api/mcp/tools'),
    staleTime: 15_000,
  });
}

export async function invalidateProject(
  qc: QueryClient,
  projectRoot: string,
): Promise<void> {
  await qc.invalidateQueries({ queryKey: pmKeys.project(projectRoot) });
}
