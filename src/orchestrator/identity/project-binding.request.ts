export type TrustedActorRole = "primary" | "maintenance" | "untrusted";
export type ProjectBindingSource = "stdio-explicit-root" | "mcp-roots" | "trusted-ide-adapter" | "explicit-cli";

export interface TrustedProjectBindingRequest {
  source: ProjectBindingSource;
  projectRoot: string;
  vaultRoot: string;
  clientNamespace: string;
  clientInstanceId: string;
  actorRole: TrustedActorRole;
  generation: number;
}

const DYNAMIC_ROOTS = new Set(["dynamic", "auto"]);
const SOURCES = new Set<ProjectBindingSource>(["stdio-explicit-root", "mcp-roots", "trusted-ide-adapter", "explicit-cli"]);
const ROLES = new Set<TrustedActorRole>(["primary", "maintenance", "untrusted"]);

export function parseTrustedProjectBindingRequest(input: Record<string, unknown>): TrustedProjectBindingRequest {
  const projectRoot = typeof input.projectRoot === "string" ? input.projectRoot.trim() : "";
  const vaultRoot = typeof input.vaultRoot === "string" ? input.vaultRoot.trim() : "";
  if (!projectRoot || DYNAMIC_ROOTS.has(projectRoot.toLowerCase())) throw new Error("PROJECT_ROOT_NOT_EXPLICIT");
  if (!vaultRoot || DYNAMIC_ROOTS.has(vaultRoot.toLowerCase())) throw new Error("VAULT_ROOT_NOT_EXPLICIT");
  if (!SOURCES.has(input.source as ProjectBindingSource)) throw new Error("BINDING_SOURCE_INVALID");
  if (!ROLES.has(input.actorRole as TrustedActorRole)) throw new Error("ACTOR_ROLE_INVALID");
  const clientNamespace = typeof input.clientNamespace === "string" ? input.clientNamespace.trim() : "";
  const clientInstanceId = typeof input.clientInstanceId === "string" ? input.clientInstanceId.trim() : "";
  if (!clientNamespace) throw new Error("CLIENT_NAMESPACE_INVALID");
  if (!clientInstanceId) throw new Error("CLIENT_INSTANCE_INVALID");
  if (!Number.isSafeInteger(input.generation) || Number(input.generation) <= 0) throw new Error("BINDING_GENERATION_INVALID");
  return {
    source: input.source as ProjectBindingSource,
    projectRoot,
    vaultRoot,
    clientNamespace,
    clientInstanceId,
    actorRole: input.actorRole as TrustedActorRole,
    generation: Number(input.generation),
  };
}
