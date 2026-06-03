export const DEFAULT_MARKDOWN_IGNORE = [
  ".obsidian/**",
  ".memory-mcp/**",
  "node_modules/**",
  "dist/**",
  "build/**",
] as const;

export const DEFAULT_SEMANTIC_EXEMPT_PATHS = ["99_Templates/**"] as const;

export interface FrontmatterPolicy {
  semanticExemptPaths: string[];
}

export function defaultFrontmatterPolicy(): FrontmatterPolicy {
  return {
    semanticExemptPaths: [...DEFAULT_SEMANTIC_EXEMPT_PATHS],
  };
}

export function normalizeVaultPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function globToRegExp(pattern: string): RegExp {
  const normalized = normalizeVaultPath(pattern);
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

export function matchesVaultPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizeVaultPath(path);
  const normalizedPattern = normalizeVaultPath(pattern);

  if (normalizedPattern === "**") return true;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }

  return globToRegExp(normalizedPattern).test(normalizedPath);
}

export function matchesAnyVaultPattern(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesVaultPattern(path, pattern));
}

export function isSemanticFrontmatterExempt(
  path: string,
  patterns: readonly string[] = DEFAULT_SEMANTIC_EXEMPT_PATHS,
): boolean {
  return matchesAnyVaultPattern(path, patterns);
}
