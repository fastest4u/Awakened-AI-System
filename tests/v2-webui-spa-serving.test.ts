import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type { FreshStartRelease } from "../src/orchestrator/fresh-start/contracts.js";
import { FreshStartInitializer } from "../src/orchestrator/fresh-start/fresh-start-initializer.js";
import { canonicalJson } from "../src/orchestrator/serialization/canonical-json.js";
import { PROJECT_STORE_MIGRATIONS } from "../src/orchestrator/storage/migrations/registry.js";
import { NodeSqliteDriver } from "../src/orchestrator/storage/node-sqlite-driver.js";
import { expectedSchemaFingerprint } from "../src/orchestrator/storage/schema-fingerprint.js";
import { inspectV2Build } from "../src/v2/build-identity.js";
import { createV2Foundation, ensureProjectV2StoreReady } from "../src/v2/composition.js";
import {
  V2_PRODUCTION_CAPABILITIES,
  V2_PRODUCTION_RECOVERY_POLICY,
  loadV2LaunchConfig,
} from "../src/v2/config.js";
import { startV2WebUiServer } from "../src/v2/webui.js";
import {
  loadSpaClientBundle,
  MAX_SPA_ASSET_BYTES,
  MAX_SPA_SCAN_DEPTH,
  renderSpaIndexHtml,
} from "../src/v2/webui/spa-assets.js";
import { activateFreshTestStore } from "./support/fresh-start-fixture.js";

function sha(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

const V2_DIST_ENTRY_URL = pathToFileURL(resolve("dist/v2.js")).href;
const V2_BUILD_MANIFEST = JSON.parse(readFileSync(resolve("dist/v2-build.json"), "utf8")) as {
  deploymentId: string;
  buildIdentityHash: string;
};
(globalThis as Record<string, unknown>).__V2_DEPLOYMENT_ID__ = V2_BUILD_MANIFEST.deploymentId;

async function createActiveStoreFixture(prefix = "pm-v2-spa-serving-") {
  const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  const v1ArchiveRoot = join(projectRoot, "memory");
  mkdirSync(v1ArchiveRoot, { recursive: true });
  writeFileSync(join(v1ArchiveRoot, "sentinel.txt"), "archive-sentinel");
  const v2VaultRoot = join(projectRoot, "memory-v2");
  const releaseId = randomUUID();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MEMORY_PROJECT_ROOT: projectRoot,
    MEMORY_V2_VAULT_PATH: v2VaultRoot,
    MEMORY_V1_ARCHIVE_PATH: v1ArchiveRoot,
    MEMORY_V2_RELEASE_ID: releaseId,
  };
  const config = loadV2LaunchConfig(env);
  const buildIdentityHash = inspectV2Build(V2_DIST_ENTRY_URL);
  const schemaIdentityHash = expectedSchemaFingerprint(PROJECT_STORE_MIGRATIONS);
  const release: Omit<FreshStartRelease, "projectId" | "vaultId" | "storeId"> = Object.freeze({
    profileVersion: 1 as const,
    releaseId,
    buildIdentityHash,
    schemaIdentityHash,
    configurationHash: sha(config),
    capabilityManifestHash: sha(V2_PRODUCTION_CAPABILITIES),
    recoveryPolicyHash: sha(V2_PRODUCTION_RECOVERY_POLICY),
    evidenceDigest: sha({ test: "v2-webui-spa-serving" }),
    createdAt: "2026-10-21T00:00:00.000Z",
  });
  const initializer = new FreshStartInitializer({
    projectionSchemaVersion: 3,
    inspectBuild: () => buildIdentityHash,
    actorFingerprint: sha({ actor: "test" }),
  });
  const initialized = await initializer.initializeFresh({
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    initializationId: randomUUID(),
    release,
  });
  const eventsPath = join(v2VaultRoot, ".memory-mcp", "v2", "events.sqlite");
  const driver = new NodeSqliteDriver({ DatabaseSync });
  const connection = driver.open(eventsPath, { mode: "existing", busyTimeoutMs: 1_000 });
  try {
    await activateFreshTestStore(
      connection,
      {
        projectId: initialized.projectId,
        vaultId: initialized.vaultId,
        storeId: initialized.storeId,
      },
      { alreadyInitialized: true },
    );
  } finally {
    connection.close();
  }
  const foundation = await createV2Foundation(config, {
    entryUrl: V2_DIST_ENTRY_URL,
  });
  return {
    projectRoot,
    v2VaultRoot,
    v1ArchiveRoot,
    config,
    foundation,
    async cleanup() {
      await foundation.close();
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function createTempSpaClient() {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pm-v2-spa-client-")));
  const indexHtml =
    '<!doctype html><html lang="th"><head><title>Project Memory V2 — Memory Studio & AI Memory Curator</title><script type="module" src="/assets/app-abc123.js"></script></head><body><div id="root"></div></body></html>';
  writeFileSync(join(dir, "index.html"), indexHtml, "utf8");

  const assetsDir = join(dir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  // >= 2 KiB js file
  const jsContent = 'console.log("hello webui spa asset serving");\n'.repeat(60);
  writeFileSync(join(assetsDir, "app-abc123.js"), jsContent, "utf8");

  // css file
  const cssContent = "body { background: #000; color: #fff; }\n";
  writeFileSync(join(assetsDir, "app-abc123.css"), cssContent, "utf8");

  // dotfile .secret
  writeFileSync(join(assetsDir, ".secret"), "secret-token", "utf8");

  return {
    dir,
    jsContent,
    cssContent,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function rawHttpGet(
  baseUrl: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolveReq, rejectReq) => {
    const u = new URL(baseUrl);
    const req = httpRequest(
      {
        hostname: u.hostname,
        port: u.port,
        path,
        method: "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () =>
          resolveReq({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", rejectReq);
    req.end();
  });
}

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'";

test("Task 2: WebUI SPA serving & /api/bootstrap suite", async (t) => {
  const store = await createActiveStoreFixture();
  const spaClient = createTempSpaClient();
  const server = await startV2WebUiServer({
    defaultProjectRoot: store.projectRoot,
    clientDistDir: spaClient.dir,
    foundations: new Map([[store.projectRoot, store.foundation]]),
    port: 0,
    host: "127.0.0.1",
  });
  const baseUrl = server.url;

  try {
    await t.test("serves index with injected csrf and default-project meta", async () => {
      const res = await rawHttpGet(baseUrl, "/");
      assert.equal(res.statusCode, 200);
      assert.ok(
        String(res.headers["content-type"]).startsWith("text/html"),
        "content-type must be text/html",
      );
      assert.equal(res.headers["cache-control"], "no-store");
      assert.equal(res.headers["content-security-policy"], EXPECTED_CSP);

      const html = res.body.toString("utf8");
      assert.match(html, /<meta name="pm-csrf-token" content="[0-9a-f]{48}">/);
      assert.ok(
        html.includes(`<meta name="pm-default-project" content="${store.projectRoot}">`),
        "HTML must contain escaped default project root meta",
      );
      assert.ok(
        html.includes("/assets/app-abc123.js"),
        "HTML must preserve original index template scripts",
      );
    });

    await t.test("serves the same index for every SPA route", async () => {
      const spaRoutes = ["/overview", "/kanban", "/graph", "/curator", "/mcp"];
      for (const route of spaRoutes) {
        const res = await rawHttpGet(baseUrl, route);
        assert.equal(res.statusCode, 200, `Route ${route} should return 200`);
        assert.ok(
          String(res.headers["content-type"]).startsWith("text/html"),
          `Route ${route} should return text/html`,
        );
        const html = res.body.toString("utf8");
        assert.match(html, /<meta name="pm-csrf-token" content="[0-9a-f]{48}">/);
        assert.ok(html.includes("/assets/app-abc123.js"));
      }

      // /nope route must 404 JSON NOT_FOUND
      const nopeRes = await rawHttpGet(baseUrl, "/nope");
      assert.equal(nopeRes.statusCode, 404);
      const nopeJson = JSON.parse(nopeRes.body.toString("utf8")) as {
        ok: boolean;
        error: string;
      };
      assert.equal(nopeJson.ok, false);
      assert.equal(nopeJson.error, "NOT_FOUND");
    });

    await t.test("serves hashed assets immutable with gzip and 304", async () => {
      // 1. Raw asset fetch
      const rawRes = await rawHttpGet(baseUrl, "/assets/app-abc123.js");
      assert.equal(rawRes.statusCode, 200);
      assert.equal(
        rawRes.headers["content-type"],
        "application/javascript; charset=utf-8",
      );
      assert.equal(
        rawRes.headers["cache-control"],
        "public, max-age=31536000, immutable",
      );
      const etag = rawRes.headers["etag"] as string;
      assert.ok(etag && etag.startsWith('"spa-'), "Asset must have strong spa- etag");
      assert.equal(rawRes.body.toString("utf8"), spaClient.jsContent);

      // 2. Gzip asset fetch
      const gzipRes = await rawHttpGet(baseUrl, "/assets/app-abc123.js", {
        "Accept-Encoding": "gzip",
      });
      assert.equal(gzipRes.statusCode, 200);
      assert.equal(gzipRes.headers["content-encoding"], "gzip");
      const decompressed = gunzipSync(gzipRes.body).toString("utf8");
      assert.equal(decompressed, spaClient.jsContent);

      // 3. 304 Not Modified
      const notModRes = await rawHttpGet(baseUrl, "/assets/app-abc123.js", {
        "If-None-Match": etag,
      });
      assert.equal(notModRes.statusCode, 304);
      assert.equal(notModRes.body.length, 0);
    });

    await t.test("refuses traversal, dotfiles and unknown assets", async () => {
      const forbiddenPaths = [
        "/assets/../index.html",
        "/assets/%2e%2e/index.html",
        "/assets/.secret",
        "/assets/missing.js",
      ];
      for (const p of forbiddenPaths) {
        const res = await rawHttpGet(baseUrl, p);
        assert.equal(res.statusCode, 404, `Path ${p} must return 404`);
      }
    });

    await t.test("returns 503 setup page when the client is not built", async () => {
      const emptyDir = realpathSync.native(mkdtempSync(join(tmpdir(), "pm-v2-empty-spa-")));
      const emptyServer = await startV2WebUiServer({
        defaultProjectRoot: store.projectRoot,
        clientDistDir: emptyDir,
        foundations: new Map([[store.projectRoot, store.foundation]]),
        port: 0,
        host: "127.0.0.1",
      });
      try {
        const res = await rawHttpGet(emptyServer.url, "/");
        assert.equal(res.statusCode, 503);
        assert.ok(
          String(res.headers["content-type"]).startsWith("text/html"),
          "content-type must be text/html",
        );
        const html = res.body.toString("utf8");
        assert.ok(
          html.includes("npm run build:webui"),
          "503 page must contain instructions to run npm run build:webui",
        );
        assert.match(html, /<meta name="pm-csrf-token" content="[0-9a-f]{48}">/);

        // API routes must still work when client is not built
        const apiRes = await rawHttpGet(emptyServer.url, "/api/projects");
        assert.equal(apiRes.statusCode, 200);
        const apiJson = JSON.parse(apiRes.body.toString("utf8")) as { ok: boolean };
        assert.equal(apiJson.ok, true);
      } finally {
        await emptyServer.close();
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    await t.test("bootstrap token authorizes mutations", async () => {
      // 1. GET /api/bootstrap
      const bootRes = await rawHttpGet(baseUrl, "/api/bootstrap");
      assert.equal(bootRes.statusCode, 200);
      assert.equal(bootRes.headers["cache-control"], "no-store");
      const bootJson = JSON.parse(bootRes.body.toString("utf8")) as {
        ok: boolean;
        csrfToken: string;
        defaultProjectRoot: string;
      };
      assert.equal(bootJson.ok, true);
      assert.equal(typeof bootJson.csrfToken, "string");
      assert.equal(bootJson.csrfToken.length, 48);
      assert.equal(bootJson.defaultProjectRoot, store.projectRoot);

      // Verify token matches the token in HTML meta
      const indexRes = await rawHttpGet(baseUrl, "/");
      const html = indexRes.body.toString("utf8");
      const metaMatch = /<meta name="pm-csrf-token" content="([0-9a-f]{48})">/.exec(html);
      assert.ok(metaMatch, "index HTML must have csrf meta");
      assert.equal(bootJson.csrfToken, metaMatch[1]);

      // 2. Mutation with bootstrap token
      const mutateWithToken = await fetch(`${baseUrl}/api/projects/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-PM-CSRF-Token": bootJson.csrfToken,
        },
        body: JSON.stringify({ projectRoot: "relative/path" }),
      });
      assert.equal(mutateWithToken.status, 400);
      const withTokenJson = (await mutateWithToken.json()) as { error: string };
      assert.equal(withTokenJson.error, "INVALID_PROJECT_ROOT");

      // 3. Mutation without token
      const mutateWithoutToken = await fetch(`${baseUrl}/api/projects/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ projectRoot: "relative/path" }),
      });
      assert.equal(mutateWithoutToken.status, 403);
      const withoutTokenJson = (await mutateWithoutToken.json()) as { error: string };
      assert.equal(withoutTokenJson.error, "CSRF_TOKEN_INVALID");
    });

    await t.test("escapes hostile default project roots", async () => {
      const html = renderSpaIndexHtml(
        '<html><head></head><body></body></html>',
        "tok",
        'C:\\a"b<c',
      );
      assert.ok(
        html.includes('content="C:\\a&quot;b&lt;c"'),
        "Default project root must be escaped",
      );
      const metaIdx = html.indexOf('<meta name="pm-default-project"');
      const headCloseIdx = html.indexOf("</head>");
      assert.ok(
        metaIdx !== -1 && headCloseIdx !== -1 && metaIdx < headCloseIdx,
        "Meta must appear before </head>",
      );
    });

    await t.test("legacy /mvc routes are gone", async () => {
      const legacyPaths = [
        "/mvc/vendor.js",
        "/mvc/models.js",
        "/mvc/controllers.js",
        "/mvc/shadcn-ui.js",
        "/mvc/views.js",
        "/mvc/web-components.js",
      ];
      for (const p of legacyPaths) {
        const res = await rawHttpGet(baseUrl, p);
        assert.equal(res.statusCode, 404, `Legacy route ${p} must return 404`);
      }
    });
  } finally {
    await server.close();
    spaClient.cleanup();
    await store.cleanup();
  }
});

async function createStaleBuildStore(prefix: string): Promise<string> {
  const projectRoot = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  await ensureProjectV2StoreReady({
    projectRoot,
    entryUrl: V2_DIST_ENTRY_URL,
    allowBootstrap: true,
    syncBuild: true,
    ensureActive: true,
    promotePrepared: true,
  });
  const eventsPath = join(projectRoot, "memory-v2", ".memory-mcp", "v2", "events.sqlite");
  const db = new DatabaseSync(eventsPath);
  try {
    db.exec("DROP TRIGGER IF EXISTS fresh_start_releases_no_update");
    db.prepare("UPDATE fresh_start_releases SET build_identity_hash = ?").run("0".repeat(64));
    db.exec(
      "CREATE TRIGGER fresh_start_releases_no_update BEFORE UPDATE ON fresh_start_releases BEGIN SELECT RAISE(ABORT, 'FRESH_START_IMMUTABLE'); END;",
    );
  } finally {
    db.close();
  }
  return projectRoot;
}

test("WebUI auto-syncs stale project build_identity_hash by default and surfaces 409 FreshStartError when disabled", async (t) => {
  const spaClient = createTempSpaClient();
  const assertReleaseMismatch409 = (res: { statusCode: number; body: Buffer }) => {
    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body.toString("utf8")) as {
      ok?: unknown;
      error?: unknown;
      message?: unknown;
    };
    assert.equal(body.ok, false);
    assert.equal(body.error, "FRESH_START_RELEASE_MISMATCH");
    assert.equal(typeof body.message, "string");
    const msg = body.message as string;
    assert.ok(msg.includes("FRESH_START_RELEASE_MISMATCH"));
    assert.ok(msg.includes("sync-build") && /[\u0E00-\u0E7F]/u.test(msg));
  };
  try {
    await t.test(
      "auto-syncs stale project build_identity_hash by default when MEMORY_V2_AUTO_SYNC_BUILD is unset",
      async () => {
        const staleRoot = await createStaleBuildStore("pm-v2-stale-sync-default-");
        const prevAutoSync = process.env.MEMORY_V2_AUTO_SYNC_BUILD;
        delete process.env.MEMORY_V2_AUTO_SYNC_BUILD;
        let srv: Awaited<ReturnType<typeof startV2WebUiServer>> | undefined;
        try {
          srv = await startV2WebUiServer({
            defaultProjectRoot: staleRoot,
            port: 0,
            entryUrl: V2_DIST_ENTRY_URL,
            clientDistDir: spaClient.dir,
          });
          const res = await rawHttpGet(srv.url, "/api/overview");
          assert.equal(res.statusCode, 200);
          const body = JSON.parse(res.body.toString("utf8")) as { ok?: unknown };
          assert.equal(body.ok, true);
        } finally {
          if (srv) await srv.close();
          if (prevAutoSync === undefined) {
            delete process.env.MEMORY_V2_AUTO_SYNC_BUILD;
          } else {
            process.env.MEMORY_V2_AUTO_SYNC_BUILD = prevAutoSync;
          }
          rmSync(staleRoot, { recursive: true, force: true });
        }
      },
    );

    await t.test(
      "surfaces 409 FRESH_START_RELEASE_MISMATCH with Thai message when autoSyncBuild is disabled",
      async () => {
        const staleRoot = await createStaleBuildStore("pm-v2-stale-sync-disabled-");
        const prevAutoSync = process.env.MEMORY_V2_AUTO_SYNC_BUILD;
        process.env.MEMORY_V2_AUTO_SYNC_BUILD = "1";
        let srv: Awaited<ReturnType<typeof startV2WebUiServer>> | undefined;
        try {
          srv = await startV2WebUiServer({
            defaultProjectRoot: staleRoot,
            port: 0,
            entryUrl: V2_DIST_ENTRY_URL,
            clientDistDir: spaClient.dir,
            autoSyncBuild: false,
          });
          const res = await rawHttpGet(srv.url, "/api/overview");
          assertReleaseMismatch409(res);
        } finally {
          if (srv) await srv.close();
          if (prevAutoSync === undefined) {
            delete process.env.MEMORY_V2_AUTO_SYNC_BUILD;
          } else {
            process.env.MEMORY_V2_AUTO_SYNC_BUILD = prevAutoSync;
          }
          rmSync(staleRoot, { recursive: true, force: true });
        }
      },
    );

    await t.test(
      "surfaces 409 FRESH_START_RELEASE_MISMATCH when MEMORY_V2_AUTO_SYNC_BUILD is '0' and autoSyncBuild is omitted",
      async () => {
        const staleRoot = await createStaleBuildStore("pm-v2-stale-sync-env0-");
        const prevAutoSync = process.env.MEMORY_V2_AUTO_SYNC_BUILD;
        process.env.MEMORY_V2_AUTO_SYNC_BUILD = "0";
        let srv: Awaited<ReturnType<typeof startV2WebUiServer>> | undefined;
        try {
          srv = await startV2WebUiServer({
            defaultProjectRoot: staleRoot,
            port: 0,
            entryUrl: V2_DIST_ENTRY_URL,
            clientDistDir: spaClient.dir,
          });
          const res = await rawHttpGet(srv.url, "/api/overview");
          assertReleaseMismatch409(res);
        } finally {
          if (srv) await srv.close();
          if (prevAutoSync === undefined) {
            delete process.env.MEMORY_V2_AUTO_SYNC_BUILD;
          } else {
            process.env.MEMORY_V2_AUTO_SYNC_BUILD = prevAutoSync;
          }
          rmSync(staleRoot, { recursive: true, force: true });
        }
      },
    );
  } finally {
    spaClient.cleanup();
  }
});

test("loadSpaClientBundle skips oversized files and directories exceeding MAX_SPA_SCAN_DEPTH", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "pm-v2-spa-bounds-")));
  try {
    writeFileSync(join(dir, "index.html"), "<html><head></head><body>ok</body></html>", "utf8");
    const assetsDir = join(dir, "assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "valid.js"), "console.log('ok');", "utf8");
    // Sparse / oversized file exceeding MAX_SPA_ASSET_BYTES (allocate buffer of MAX + 1 byte)
    writeFileSync(join(assetsDir, "too-big.js"), Buffer.alloc(MAX_SPA_ASSET_BYTES + 1));

    // Directory exceeding MAX_SPA_SCAN_DEPTH
    let deepDir = assetsDir;
    let urlPath = "/assets";
    for (let d = 1; d <= MAX_SPA_SCAN_DEPTH + 1; d++) {
      deepDir = join(deepDir, `d${d}`);
      urlPath += `/d${d}`;
      mkdirSync(deepDir, { recursive: true });
      writeFileSync(join(deepDir, `lvl${d}.js`), `// depth ${d}`, "utf8");
    }

    const bundle = loadSpaClientBundle(dir);
    assert.ok(bundle, "Bundle should still load valid assets");
    assert.equal(bundle.assets.has("/assets/valid.js"), true);
    assert.equal(bundle.assets.has("/assets/too-big.js"), false);
    assert.equal(bundle.assets.has(`${urlPath}/lvl${MAX_SPA_SCAN_DEPTH + 1}.js`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
