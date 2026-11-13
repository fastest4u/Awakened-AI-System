import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

export const SPA_ROUTE_PATHS: ReadonlySet<string> = new Set<string>([
  "/",
  "/index.html",
  "/overview",
  "/kanban",
  "/graph",
  "/curator",
  "/mcp",
]);

export interface PrecomputedStaticAsset {
  readonly raw: Buffer;
  readonly gzip: Buffer | null;
  readonly etag: string;
  readonly contentType: string;
}

export interface SpaClientBundle {
  readonly indexTemplate: string;
  readonly assets: ReadonlyMap<string, PrecomputedStaticAsset>;
}

function getContentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) {
    return "application/javascript; charset=utf-8";
  }
  if (lower.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (lower.endsWith(".woff2")) {
    return "font/woff2";
  }
  if (lower.endsWith(".woff")) {
    return "font/woff";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".ico")) {
    return "image/x-icon";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

function isGzipEligible(contentType: string): boolean {
  return (
    contentType.startsWith("application/javascript") ||
    contentType.startsWith("text/") ||
    contentType.startsWith("image/svg+xml") ||
    contentType.startsWith("application/json")
  );
}

function precomputeAsset(raw: Buffer, filename: string): PrecomputedStaticAsset {
  const contentType = getContentType(filename);
  const gzip =
    isGzipEligible(contentType) && raw.byteLength >= 1024
      ? gzipSync(raw, { level: 6 })
      : null;
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 24);
  return {
    raw,
    gzip,
    etag: `"spa-${digest}"`,
    contentType,
  };
}

export function resolveSpaClientDir(opts: {
  readonly clientDistDir?: string;
  readonly entryUrl?: string;
  readonly cwd?: string;
}): string {
  if (opts.clientDistDir !== undefined && opts.clientDistDir.trim().length > 0) {
    return resolve(opts.clientDistDir.trim());
  }

  const candidates: string[] = [];
  if (opts.entryUrl) {
    try {
      const entryPath = fileURLToPath(opts.entryUrl);
      candidates.push(resolve(dirname(entryPath), "webui"));
    } catch {
      // Ignore URL error
    }
  }
  const cwd = opts.cwd ?? process.cwd();
  candidates.push(resolve(cwd, "dist", "webui"));

  for (const candidate of candidates) {
    if (existsSync(join(candidate, "index.html"))) {
      return candidate;
    }
  }

  return candidates[0]!;
}

export function loadSpaClientBundle(dir: string): SpaClientBundle | null {
  const resolvedDir = resolve(dir);
  const indexPath = join(resolvedDir, "index.html");
  if (!existsSync(indexPath)) {
    return null;
  }
  try {
    const indexStat = statSync(indexPath);
    if (!indexStat.isFile()) return null;
  } catch {
    return null;
  }

  let indexTemplate: string;
  try {
    indexTemplate = readFileSync(indexPath, "utf8");
  } catch {
    return null;
  }

  const assets = new Map<string, PrecomputedStaticAsset>();

  let topEntries: Dirent[];
  try {
    topEntries = readdirSync(resolvedDir, { withFileTypes: true });
  } catch {
    return null;
  }

  for (const entry of topEntries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(resolvedDir, entry.name);
    let isSymlink = false;
    try {
      isSymlink = entry.isSymbolicLink() || lstatSync(fullPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink) continue;

    if (entry.isFile()) {
      const lower = entry.name.toLowerCase();
      if (lower === "index.html" || lower.endsWith(".html") || lower.endsWith(".map")) {
        continue;
      }
      try {
        const raw = readFileSync(fullPath);
        assets.set(`/${entry.name}`, precomputeAsset(raw, entry.name));
      } catch {
        // Ignore file read error
      }
    }
  }

  const assetsSubdir = join(resolvedDir, "assets");
  if (existsSync(assetsSubdir)) {
    function scanDir(currentDir: string, urlPrefix: string): void {
      let entries: Dirent[];
      try {
        entries = readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(currentDir, entry.name);
        let isSymlink = false;
        try {
          isSymlink = entry.isSymbolicLink() || lstatSync(fullPath).isSymbolicLink();
        } catch {
          continue;
        }
        if (isSymlink) continue;

        if (entry.isDirectory()) {
          scanDir(fullPath, `${urlPrefix}/${entry.name}`);
        } else if (entry.isFile()) {
          if (entry.name.toLowerCase().endsWith(".map")) continue;
          try {
            const raw = readFileSync(fullPath);
            assets.set(`${urlPrefix}/${entry.name}`, precomputeAsset(raw, entry.name));
          } catch {
            // Ignore file read error
          }
        }
      }
    }
    scanDir(assetsSubdir, "/assets");
  }

  return {
    indexTemplate,
    assets,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

export function renderSpaIndexHtml(
  template: string,
  csrfToken: string,
  defaultProjectRoot: string,
): string {
  const metaTags = `<meta name="pm-csrf-token" content="${escapeHtml(csrfToken)}">\n<meta name="pm-default-project" content="${escapeHtml(defaultProjectRoot)}">\n`;
  const headCloseIdx = template.toLowerCase().indexOf("</head>");
  if (headCloseIdx !== -1) {
    return template.slice(0, headCloseIdx) + metaTags + template.slice(headCloseIdx);
  }
  return template + metaTags;
}

export function renderClientMissingHtml(
  csrfToken: string,
  defaultProjectRoot: string,
): string {
  const escapedCsrf = escapeHtml(csrfToken);
  const escapedRoot = escapeHtml(defaultProjectRoot);
  return `<!doctype html>
<html lang="th">
<head>
  <meta charset="utf-8">
  <title>Project Memory V2 — Memory Studio & AI Memory Curator</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="pm-csrf-token" content="${escapedCsrf}">
  <meta name="pm-default-project" content="${escapedRoot}">
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #09090b; color: #f4f4f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 1.5rem; box-sizing: border-box; }
    .card { max-width: 32rem; width: 100%; background: #18181b; border: 1px solid #27272a; border-radius: 0.75rem; padding: 2rem; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.3); }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 1rem 0; color: #fafafa; }
    p { margin: 0 0 1rem 0; font-size: 0.9375rem; line-height: 1.5; color: #a1a1aa; }
    pre { background: #09090b; border: 1px solid #27272a; border-radius: 0.5rem; padding: 0.75rem 1rem; font-size: 0.875rem; color: #38bdf8; overflow-x: auto; margin: 0.5rem 0 1rem 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Project Memory V2 — ไม่พบไฟล์บิลด์ของ WebUI</h1>
    <p>ยังไม่ได้บิลด์ไคลเอนต์ WebUI (SPA) กรุณารันคำสั่งต่อไปนี้ในเทอร์มินัลเพื่อตั้งค่าและสร้างบิลด์:</p>
    <p>WebUI client build not found. Please run the following commands to set up and build the client:</p>
    <pre><code>npm run setup:webui
npm run build:webui</code></pre>
  </div>
</body>
</html>`;
}
