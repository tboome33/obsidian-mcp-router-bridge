# Changelog

All notable changes to `mcp-router-bridge` (the Obsidian community plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

## [Unreleased]

Nothing pending right now.

## [0.3.0] — 2026-06-02 — `/open` heading anchors + treeview reveal

Deep-linking for click-to-open. `GET /open/<path>` now accepts two optional query params so a clicked link can land on a specific section and surface the note in the file tree.

### Added

- **`?h=<heading>` — scroll to a heading.** The handler navigates via `app.workspace.openLinkText("<path>#<heading>", "", false)` (the same resolution a `[[note#Heading]]` wikilink click uses) instead of `leaf.openFile`, so Obsidian scrolls to the heading. Obsidian headings ARE their own anchor — nothing is inserted into the note (read-only). The heading travels as a **query param**, never as a `#fragment`: browsers never transmit the fragment to the server, so `#…` would be invisible to the handler. Accepted with or without a leading `#`.
- **`?reveal=0` — opt out of the treeview reveal.** By default `/open` now also runs the core `file-explorer:reveal-active-file` command after navigating, so the opened note is **revealed + selected** in the file-explorer tree. Best-effort (wrapped + swallowed if the File Explorer core plugin is disabled). `?reveal=0` / `false` / `no` / `off` disables it. Backward compatible: a bare `/open/<path>` behaves exactly as before, plus the reveal.
- **`parseOpenParams()`** — extracted as a pure, exported function (query → `{ heading, reveal }`) with the heading-normalization + reveal-default logic. Unit-tested in isolation.

### Tests

- **`tests/open-params.test.mjs`** (13 tests) + a `test` npm script (`node --test tests/*.test.mjs`) — the bridge's first test suite. Covers heading normalization (leading-`#` strip, trim, empty→null, array-collapse, non-string), the reveal default + falsy-token set, the raw-URL fallback parse, and null/undefined robustness. Runs under Node's built-in TS type stripping (≥ 23.6) — `open.ts` has only erasable syntax, so importing it pulls in no `obsidian` runtime dependency.

### Migration

- Existing installs: pull, `npm install`, `npm run build` (deploys to `.template`), then `npm run deploy:all` to propagate to consumer vaults, and reload Obsidian once per running instance. Old click-to-open URLs keep working unchanged (they just gain the treeview reveal). The router emits `?h=` only when a caller passes an `anchor` (router ≥ 0.22.0).

## [0.2.1] — 2026-05-23

Triggered by Roland clicking a click-to-open link (`http://127.0.0.1:27141/open/wiki/Refs/dedibox-rdp-pc-cabinet.md`) that returned **HTTP 40101 Authorization required**. Audit across the 10 configured vaults revealed two compounding drifts: 8/10 vaults had bridge v0.1.1 (no `/open/*` route) and 8/10 had Local REST API v3.6.1 (no `addPublicRoute()` method — see "Documentation" below). Both invisible to existing diagnostics.

### Added

- **`postbuild` hook in `package.json`** — `npm run build` now auto-deploys to `.template` via the existing `deploy.mjs` script. Closes the silent-drift root cause: prior to this hook, `.template` could lag behind a fresh build (which is what produced the 8-vault v0.1.1 state — the v0.2.0 build was made on 2026-05-18 but `deploy.mjs` was never invoked, so `.template` stayed at v0.1.1 and all consumer vaults inherited the stale version).
- **`npm run deploy:all`** — one-shot command: builds + auto-pushes to `.template` (via postbuild) + propagates to every vault in the router's portRegistry via `node <router>/scripts/setup-vault.mjs --sync-all --force`. Router-repo path resolved as a sibling directory by default (`../obsidian-mcp-router`), overridable via `OBSIDIAN_ROUTER_REPO` env var.
- **`deploy.mjs --all` flag** — implements the propagation step of `deploy:all`. Errors out with a clear remediation message if `--all` is passed but the router repo can't be located. Without the flag, `deploy.mjs` behavior is unchanged.

### Documentation

- **`CHANGELOG.md` v0.2.0 correction**: the prior entry stated `addPublicRoute()` requires "Local REST API recent v3.x+" — this is **wrong**. The method was introduced in **Local REST API v4.0.0**. On v3.x lines, the bridge silently logs `addPublicRoute() not exposed — skipping /open/* registration` and Local REST API's auth middleware returns HTTP 401 on every `/open/*` request. This misleading line is the historic record of the prereq bug observed in production this week.
- `wiki/obsidian-mcp-router-bridge/project-bridge.md` (in the companion vault) — Build & deploy section updated to document the new `npm run deploy:all` workflow.

### Migration

- Existing installs: pull, `npm install`, `npm run deploy:all`, then reload Obsidian once per running instance to activate the new code in memory. The router's `npm run audit:bridge-readiness` (router v0.12.3) verifies all four prerequisites including the live `/open` probe.

## [0.2.0] — 2026-05-18

### Added

- **`GET /open/<vault-relative-path>` route** — navigates Obsidian to the specified file in the active pane. Registered via Local REST API's `addPublicRoute()` (no Bearer-token check) — so the URL is directly clickable from a browser or any CLI that emits clickable http links. Designed for surfacing wiki pages from chat / terminal contexts where `obsidian://` URIs aren't dispatched (e.g. Claude Code CLI only dispatches `http(s)`).

  Internal: `src/handlers/open.ts` calls `app.workspace.openLinkText(path, '', false)` after path-traversal validation and vault-existence check. Returns a tiny auto-closing HTML response (best-effort `window.close()`).

  Security: loopback-only (Local REST API binds 127.0.0.1; the handler double-checks `req.ip` as defense-in-depth). Path traversal refused (`..` segments, absolute paths, drive letters). File must exist in the vault (404 otherwise). No auth — justified because the scope is navigation-only (no content read, no write, no execution), the binding is loopback (other local processes already can read the vault directly), and embedding a Bearer token into a clickable URL would be insecure and impractical.

  Requires Local REST API version that exposes `addPublicRoute()` (recent v3.x+). If the method isn't available, the bridge logs a warning at load and skips the registration — the other two routes (`/search/smart`, `/templates/execute`) still register normally.

### Changed

- `manifest.json` description and `package.json` description updated to mention the new route.

### Migration

- Existing installs: rebuild and re-deploy, then disable+re-enable the plugin in Obsidian (or run "Reload app without saving" from the command palette) to load the v0.2.0 routes.
- Consumers of the new route (e.g. obsidian-mcp-router's `~/.claude/CLAUDE.md` formatting rule): URL format is `http(s)://127.0.0.1:<port>/open/<URL-encoded-vault-path>`. Port = the vault's Local REST API port (HTTPS by default on 27124+ in router-managed installs, HTTP if enabled in Local REST API settings).

## [0.1.1] — 2026-05-xx

### Fixed
- Rename plugin id (drop `obsidian-` prefix per community-plugin guidelines).
- Drop "Obsidian" from the description (redundant context).

## [0.1.0] — 2026-05-xx

Initial release.

- `POST /search/smart` — Smart Connections semantic search bridge.
- `POST /templates/execute` — Templater template execution bridge with `tp.mcpTools.prompt("key")` accessor.
