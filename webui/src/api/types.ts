export interface ProjectSummary {
  projectRoot: string;
  name: string;
  initialized: boolean;
  mode: string;
  productionReady: boolean;
  projectId?: string;
  vaultId?: string;
  releaseId?: string;
  generation?: number | string;
  error?: string;
}

export interface OverviewStatusInfo {
  projectId?: string;
  vaultId?: string;
  releaseId?: string;
  mode?: string;
  generation?: number | string;
  productionReady?: boolean;
  initialized?: boolean;
  error?: string;
}

export interface ProjectsResponse {
  ok: boolean;
  defaultProjectRoot: string;
  projects: ProjectSummary[];
}

export interface BootstrapResponse {
  ok: boolean;
  csrfToken: string;
  defaultProjectRoot: string;
}

export interface NoteItem {
  id: string;
  recordId: string;
  kind: string;
  recordKind: string;
  title: string;
  summary: string;
  body: unknown;
  status: string;
  filePaths: string[];
  symbols: string[];
  wikilinks: string[];
  sessionId: string | null;
}

export interface NoteDetailResponse {
  ok: boolean;
  projectRoot: string;
  note: NoteItem | null;
  error?: string;
  message?: string;
}

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly kind: 'session' | 'note' | 'file' | 'symbol';
  readonly subkind?: string;
  readonly status?: string;
  readonly recordId?: string;
  readonly sessionId?: string;
  readonly currentTask?: string;
  readonly noteCount?: number;
  readonly summary?: string;
  readonly filePaths?: readonly string[];
  readonly symbols?: readonly string[];
  readonly wikilinks?: readonly string[];
  readonly supersedesRecordIds?: readonly string[];
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly relation:
    | 'created-in-session'
    | 'forked-from'
    | 'touches-file'
    | 'mentions-symbol'
    | 'defines-symbol'
    | 'links-to-note'
    | 'supersedes'
    | 'causal-triad';
}

export interface GraphResponse {
  ok: boolean;
  projectRoot: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  causalTriads?: any[];
  stats?: {
    sessionNodes: number;
    noteNodes: number;
    fileNodes: number;
    symbolNodes: number;
    edgeCount: number;
  };
}

export interface OverviewResponse {
  ok: boolean;
  projectRoot: string;
  projectName: string;
  status: OverviewStatusInfo | string;
  lifecycle?: {
    sessions?: any[];
    latestCheckpoint?: any;
  };
  audit?: {
    healthScore: number;
    counts?: any;
    recommendations?: any[];
    duplicateGroups?: any[];
  };
  causalTriads?: any[];
  analytics?: {
    byStatus?: Record<string, number>;
    byKind?: Record<string, number>;
    activitySeries?: {
      label: string;
      notes: number;
      verified: number;
      sessions: number;
    }[];
  };
}

export interface CuratorAudit {
  projectRoot: string;
  healthScore: number;
  counts?: any;
  recommendations?: any[];
  duplicateGroups?: {
    title: string;
    keeperRecordId: string;
    duplicateRecordIds: string[];
  }[];
  staleItems?: any[];
}

export interface AutoCurateReceipt {
  projectRoot: string;
  beforeHealthScore: number;
  afterHealthScore: number;
  promoted: any[];
  superseded: any[];
  expired: any[];
}

export interface CuratorChatReply {
  projectRoot: string;
  reply: string;
  intent: string;
  executedTools: any[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    properties: Record<string, any>;
    required?: string[];
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  };
}

export interface McpCallResponse {
  ok: boolean;
  tool: string;
  result: any;
}

export type GovernanceAction =
  | 'promote'
  | 'supersede'
  | 'retract'
  | 'expire'
  | 'writeADR'
  | 'writeInsight'
  | 'writeMistake';
