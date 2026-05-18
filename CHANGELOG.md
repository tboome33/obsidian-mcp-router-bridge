# Changelog

All notable changes to `mcp-router-bridge` (the Obsidian community plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

## [Unreleased]

Nothing pending right now.

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
