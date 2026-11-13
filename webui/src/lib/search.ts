export type TabId = 'overview' | 'kanban' | 'graph' | 'curator' | 'mcp';

export interface AppSearch {
  project?: string;
  note?: string;
  q?: string;
  kind?: string;
  status?: string;
  node?: string;
  session?: string;
}

const VALID_TABS: readonly TabId[] = ['overview', 'kanban', 'graph', 'curator', 'mcp'];

export function validateAppSearch(raw: Record<string, unknown>): AppSearch {
  const result: AppSearch = {};
  const allowedKeys = new Set([
    'project',
    'note',
    'q',
    'kind',
    'status',
    'node',
    'session',
  ]);

  for (const [key, val] of Object.entries(raw)) {
    if (allowedKeys.has(key) && typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed !== '' && trimmed.toLowerCase() !== 'all') {
        (result as any)[key] = val;
      }
    }
  }

  return result;
}

export function legacyHashToHref(hash: string): string | null {
  if (!hash) return null;
  const clean = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!clean.trim()) return null;

  let tabCandidate = '';
  let params: URLSearchParams;

  if (clean.includes('?')) {
    const qIdx = clean.indexOf('?');
    const tabPart = clean.slice(0, qIdx);
    const queryPart = clean.slice(qIdx + 1);
    params = new URLSearchParams(queryPart);
    if (tabPart.includes('=')) {
      const tabParams = new URLSearchParams(tabPart);
      tabCandidate = tabParams.get('view') || tabParams.get('tab') || '';
    } else {
      tabCandidate = tabPart;
    }
  } else if (clean.includes('=')) {
    params = new URLSearchParams(clean);
    tabCandidate = params.get('view') || params.get('tab') || '';
  } else {
    tabCandidate = clean;
    params = new URLSearchParams();
  }

  params.delete('view');
  params.delete('tab');

  const raw: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) {
    if (k === 'type' && !params.has('kind')) {
      raw['kind'] = v;
    } else if (k !== 'type') {
      raw[k] = v;
    }
  }

  let validTab: TabId = 'overview';
  if (VALID_TABS.includes(tabCandidate as TabId)) {
    validTab = tabCandidate as TabId;
  }

  const validated = validateAppSearch(raw);

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(validated)) {
    if (v !== undefined) {
      searchParams.set(k, v);
    }
  }

  const qs = searchParams.toString();
  return qs ? `/${validTab}?${qs}` : `/${validTab}`;
}
