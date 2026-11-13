# Project Memory V2 WebUI — Vite + React SPA Migration (Design)

Date: 2026-11-13 · Status: user requested direct execution (skipped Q&A) · Owner calls marked **[call]**

## Intent

The current Mission Control WebUI (`src/v2/webui/*.ts`) is a hand-written React/TanStack/shadcn
*clone* shipped as JavaScript template strings (`/mvc/*.js`). The user finds it **dated-looking and
not smooth**, and wants a real **Vite + React + TanStack + shadcn/ui + lucide** SPA because that
ecosystem is the one that can be extended furthest.

Success = opening `npm run webui` → `http://127.0.0.1:4321` shows a modern, fluid single-page app
with every capability of today's UI, built from real `.tsx` with type-checking, HMR in dev, and
real component libraries.

## Goals

1. Feature parity with the current 5 views (Overview, Kanban, Knowledge Graph, AI Curator,
   MCP Console) + Note Detail view + project switcher/registration + theme toggle + deep links +
   keyboard shortcuts — Thai UI copy preserved.
2. Feels modern and fluid: client-side routing without reloads, skeletons instead of blank
   states, cached data reused across tabs (TanStack Query), hover-intent prefetch, view
   transitions, toast notifications, command palette.
3. Real stack: Vite, React 19, TypeScript strict, TanStack Query v5, TanStack Router,
   Tailwind CSS v4 + shadcn/ui components, lucide-react icons, recharts (shadcn charts).
4. The backend (`node:http` server, `/api/*`, MCP server, SQLite, governance, curator) keeps its
   contract and its security (Host allowlist, CSRF token + Origin/Sec-Fetch-Site checks, CSP).

## Non-goals

- No change to the MCP server, event store, projection engine, or `/api/*` JSON shapes (additive
  endpoint `/api/bootstrap` only).
- No SSR, no Next.js, no remote hosting, no auth system beyond today's local CSRF model.
- No new product features beyond parity + the fluidity items in Goal 2.

## Anti-goals (failure even if it "works")

- Weakening CSP (no `unsafe-eval`, no inline `<script>`), dropping CSRF/Host checks.
- Breaking the root build/installation policy (`scripts/build.js`, `check-build-installation.js`,
  root `package-lock.json`) or the exact-script assertions in `tests/ci-*.test.ts`.
- Changing `dist/v2*.js` build identity / vault `buildIdentityHash` semantics.
- Losing Thai IME safety (Enter must not submit while composing).

## Constraints discovered in the codebase

- Root `package.json`/`package-lock.json` are validated by `scripts/check-build-installation.js`
  and `tests/build-installation-policy.test.ts`; `scripts.build` and `scripts["test:build-artifacts"]`
  are asserted verbatim by `tests/ci-lifecycle-gates.test.ts` / `tests/ci-fresh-start-foundation.test.ts`.
- Root `tsconfig.json` includes only `src/**/*.ts`.
- `src/v2/build-identity.ts` hashes only `v2.js`, `v2-admin.js`, workers and internal read
  artifacts — files under `dist/webui/` do not affect build identity.
- CSP today: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'`.
- Mutations require header `X-PM-CSRF-Token` matching the per-process token; Origin port must
  equal Host port.

## Architecture **[call]**

```
webui/                      ← standalone npm package (own package.json + package-lock.json)
  index.html
  vite.config.ts            ← build.outDir = ../dist/webui, dev proxy /api → 127.0.0.1:4321
  src/
    main.tsx, router.tsx, routes/*.tsx   (TanStack Router, browser history, lazy routes)
    api/   client.ts (fetch + CSRF + AbortSignal), types.ts, queries.ts (queryOptions factories)
    lib/   pure tested logic (search params, legacy hash redirect, starter JSON, markdown,
           graph layouts, chart math)
    components/ui/*         ← shadcn/ui generated components
    components/*            ← app components (shell, charts, graph, note view …)
    features/<view>/*       ← one folder per view
src/v2/webui.ts             ← serves dist/webui (index with injected meta, /assets/* cached)
```

- **Isolation [call]:** a separate `webui/` package keeps every new dependency out of the root
  lockfile, so the root build policy and CI-script assertions stay untouched.
- **Build output [call]:** `vite build` writes to `dist/webui/` (already git-ignored). New root
  scripts: `build:webui` (`npm --prefix webui run build`), `test:webui` (`npm --prefix webui test`),
  `dev:webui` (`npm --prefix webui run dev`), `setup:webui` (`npm --prefix webui ci`). Root
  `build`, `test`, `test:build-artifacts` stay byte-identical.
- **Serving [call]:** `webui.ts` resolves the client directory from (1) `options.clientDistDir`,
  (2) `<dir of entryUrl>/webui`, (3) `<cwd>/dist/webui`. It serves `index.html` for the SPA route
  allowlist `/`, `/overview`, `/kanban`, `/graph`, `/curator`, `/mcp` (+ `/index.html`), injecting
  `<meta name="pm-csrf-token">` and `<meta name="pm-default-project">` per request
  (`cache-control: no-store`). `/assets/<file>` is served from the precomputed in-memory map
  (raw + gzip + strong ETag, `cache-control: public, max-age=31536000, immutable`, 304 support),
  strictly contained (no traversal, no dotfiles). Missing build → HTTP 503 HTML page telling the
  user to run `npm run setup:webui && npm run build:webui`. CSP unchanged.
- **Dev bootstrap [call]:** new `GET /api/bootstrap` → `{ ok, csrfToken, defaultProjectRoot }`
  so the Vite dev server (proxied, Host/Origin rewritten to 127.0.0.1:4321) works without the
  injected meta. Same-origin-only exposure, equivalent to the meta tag.
- **Routing [call]:** TanStack Router with browser history. Search params per route:
  `project`, `note` (opens Note Detail), `q`, `kind`, `status`, `node`, `session`. On boot, a
  legacy hash (`#kanban?q=x&note=y`) is rewritten to `/kanban?q=x&note=y` (replace).
- **Data [call]:** TanStack Query, keys `['pm-v2', <resource>, projectRoot, …params]`,
  `staleTime` 15 000 ms, `placeholderData: keepPreviousData` for searches, 250 ms debounced
  Kanban search, abort via `signal`, project-scoped invalidation after mutations, no
  invalidation after `readOnlyHint: true` MCP tools.
- **UI kit [call]:** shadcn/ui (style `new-york`, base color `zinc`, CSS variables), Tailwind v4
  via `@tailwindcss/vite`, `tw-animate-css`, lucide-react, recharts through shadcn `chart`,
  sonner toasts, cmdk command palette (Ctrl+K and `/`), self-hosted fonts
  (`@fontsource-variable/inter`, `@fontsource/noto-sans-thai`). Dark theme default; toggle
  persisted in `localStorage['pm-v2-theme']` (same key as today).
- **Fluidity [call]:** lazy route chunks, `defaultPreload: 'intent'`, router view transitions,
  skeleton loaders, optimistic disabling of buttons while mutations run, non-layout-shifting
  toasts.
- **Testing [call]:** Vitest + jsdom + Testing Library (+ user-event) inside `webui/` for pure
  logic and components; node:test for the server serving contract using a temporary fake client
  dist (tests do not require running Vite).
- **Legacy removal [call]:** once the React views reach parity, delete `/mvc/*` routes and the
  string-runtime modules (`vendor-runtime.ts`, `shadcn-ui.ts`, client parts of
  `views-and-web-components.ts`, `renderMvcControllersJs`, `renderMvcModelsJs`) and the VM-based
  frontend tests that exercised them; server-side models/controllers stay.

## Left to the builder

Exact component decomposition inside each feature folder, chart styling details, animation
timing, and Tailwind class choices — as long as parity, Thai copy, and the constraints above hold.
