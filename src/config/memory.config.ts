import { resolve } from "node:path";

export interface MemoryConfig {
  projectRoot: string;
  vaultRoot: string;
  vaultDirName: string;
}

const firstDefined = (...values: Array<string | undefined>) => values.find((value) => value && value.trim().length > 0);

export function loadMemoryConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): MemoryConfig {
  const projectRoot = resolve(firstDefined(env.MEMORY_PROJECT_ROOT, env.PROJECT_ROOT, env.WORKSPACE_ROOT) ?? cwd);
  const vaultDirName = firstDefined(env.MEMORY_VAULT_DIR) ?? "memory";
  const vaultRoot = env.MEMORY_VAULT_PATH ? resolve(env.MEMORY_VAULT_PATH) : resolve(projectRoot, vaultDirName);

  return {
    projectRoot,
    vaultRoot,
    vaultDirName,
  };
}
