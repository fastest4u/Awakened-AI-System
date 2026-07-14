import { join, resolve } from "node:path";
import { canonicalExistingDirectory } from "./canonical-path.js";
import type {
  ProjectDescriptorV1,
  ProjectStoreRoute,
  WorkspaceSnapshot,
} from "./contracts.js";

export class ProjectStoreRouter {
  route(
    descriptor: ProjectDescriptorV1,
    vaultRoot: string,
    workspace: WorkspaceSnapshot,
  ): ProjectStoreRoute {
    const base = workspace.kind === "git"
      ? resolve(workspace.gitCommonDir, "project-memory", descriptor.projectId, "v2")
      : resolve(canonicalExistingDirectory(vaultRoot), ".memory-mcp", "v2");

    return {
      kind: workspace.kind === "git" ? "git-common" : "vault-local",
      storeRoot: base,
      eventsPath: join(base, "events.sqlite"),
      storeManifestPath: join(base, "store-manifest.json"),
      projectionManifestPath: join(base, "current-projection.json"),
    };
  }
}
