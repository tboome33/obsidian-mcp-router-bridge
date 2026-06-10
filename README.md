# obsidian-mcp-router-bridge

A minimal Obsidian community plugin that adds four REST routes to the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin:

| Route | Auth | Delegates to | Used by |
|---|---|---|---|
| `POST /search/smart` | Bearer | [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) — semantic search via vector embeddings | `obsidian-mcp-router` `search_smart` tool |
| `POST /templates/execute` | Bearer | [Templater](https://github.com/SilentVoid13/Templater) — render a template, optionally write to a new file | `obsidian-mcp-router` `execute_template` tool |
| `GET /open/<path>` | **None** (loopback-only, public route) | Obsidian's `workspace.openLinkText` — navigate to a vault file | Click-to-open links from Claude Code chat / any client emitting clickable http URLs |
| `GET /ping` | **None** (loopback-only, public route) | Nothing — returns a bare `{"pong":true}`; optional `?v=<vault-name>` answers 404 unless the name matches this vault | Smart-link resolver pages probing for a local mirror — see [Presence heartbeat + /ping](#presence-heartbeat--ping-smart-links) |

It also runs a **presence heartbeat** that advertises this device as an active local mirror — see [Presence heartbeat + /ping](#presence-heartbeat--ping-smart-links).

## Why this exists

The companion router project [`obsidian-mcp-router`](https://github.com/tboome33/obsidian-mcp-router) needs two REST routes — `/search/smart` and `/templates/execute` — to expose semantic search and Templater execution as MCP tools. Local REST API doesn't ship those routes natively; this plugin adds them on top, in the smallest, most boring way possible.

What this plugin does **not** ship:
- ❌ Any bundled native executable
- ❌ A built-in MCP server (the router handles that, externally)
- ❌ Any telemetry or remote calls

What it does:
- ✅ Four REST handlers that delegate to plugins / Obsidian APIs you already have (Smart Connections + Templater + Obsidian workspace navigation)
- ✅ A `tp.mcpTools.prompt("key")` accessor inside Templater templates — used by the router to inject arguments into rendered templates
- ✅ A no-auth loopback-only `GET /open/<path>` for clickable http links — see [Click-to-open](#click-to-open) below
- ✅ A no-auth loopback-only `GET /ping` + a 5-minute presence heartbeat for smart-link device detection — see [Presence heartbeat + /ping](#presence-heartbeat--ping-smart-links) below

## Install

### Manual install (until accepted in the community plugins marketplace)

```bash
# 1. Build the plugin
git clone https://github.com/tboome33/obsidian-mcp-router-bridge.git
cd obsidian-mcp-router-bridge
npm install
npm run build

# 2. Copy the built artifacts to your vault's plugins folder
#    (replace <VAULT> with your vault's absolute path).
#    The folder name MUST match the `id` in manifest.json — `mcp-router-bridge`.
mkdir -p "<VAULT>/.obsidian/plugins/mcp-router-bridge"
cp main.js manifest.json "<VAULT>/.obsidian/plugins/mcp-router-bridge/"

# 3. Restart Obsidian, enable the plugin in:
#    Settings → Community plugins → MCP Router Bridge
```

> **Migrating from v0.1.0?** The plugin ID was renamed from `obsidian-mcp-router-bridge` to `mcp-router-bridge` in v0.1.1 to comply with Obsidian's community-plugin naming policy ("obsidian" is not allowed in plugin IDs since it's redundant). After installing v0.1.1 to the new folder, delete the legacy `<VAULT>/.obsidian/plugins/obsidian-mcp-router-bridge/` folder. Restart Obsidian. The plugin's settings (none currently) and behavior are unchanged.

## Click-to-open

`GET /open/<vault-relative-path>` opens a file in Obsidian when hit. **No Bearer token required** — this is a `addPublicRoute()` registration (Local REST API v3.x+ feature). Designed for surfacing wiki pages from clients that emit clickable http(s) links (Claude Code CLI, browsers, etc.) where `obsidian://` URIs aren't dispatched.

### How to use

```
https://127.0.0.1:<port>/open/<URL-encoded-vault-path>
```

Example for `wiki/references/router-agents.md` in a vault whose Local REST API runs on port 27132:

```
https://127.0.0.1:27132/open/wiki%2Freferences%2Frouter-agents.md
```

A click → browser GETs the URL → bridge calls `app.workspace.openLinkText` → Obsidian navigates to the file → browser tab shows a tiny "Opened in Obsidian" page that attempts to auto-close (browser-dependent).

### Security model

- **Loopback-only.** Local REST API binds 127.0.0.1 by default; the handler additionally checks `req.ip` as defense-in-depth and refuses non-loopback requests.
- **No auth.** The scope is intentionally minimal — navigation only, no content read, no write, no execution. Other processes running locally as the same user could already read the vault directly via the filesystem; this route doesn't expand their attack surface.
- **Path traversal refused.** `..` segments, absolute paths, Windows drive letters all return 403.
- **File must exist.** `getAbstractFileByPath` returns null → 404.

Why no Bearer token: a click navigation cannot attach an `Authorization` header, and embedding the token into the URL would expose it in browser history and clipboard. Localhost + minimal scope makes the unauth registration the right trade-off here.

### HTTPS cert warning

Local REST API ships HTTPS with a self-signed cert by default. First click per port shows a browser warning ("Not Secure / Advanced / Continue"). Subsequent clicks within the same browser session are fine. To eliminate the warning, enable the **HTTP server** in Settings → Local REST API and use that port instead of the HTTPS one.

### Requirements

- `mcp-router-bridge` ≥ v0.2.0 installed and enabled in the vault.
- Local REST API version that exposes `addPublicRoute()` (v3.x recent — if not available, the bridge logs a warning at load and skips this route; the other two routes still work normally).

### Verify

After enabling, hit the Local REST API root and confirm the bridge appears in `apiExtensions`:

```bash
# Replace 27124 with the port shown in your Local REST API plugin settings.
# 27124 is the default; obsidian-mcp-router users will typically have a
# different port per vault (set by setup-vault.mjs).
curl -sk -H "Authorization: Bearer <api-key>" "https://127.0.0.1:27124/" | grep -A 4 mcp-router-bridge
```

Or call a route directly:

```bash
curl -sk -X POST \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"query":"trading","filter":{"limit":3}}' \
  "https://127.0.0.1:27124/search/smart"
```

## Presence heartbeat + /ping (smart links)

Two small pieces (v0.4.0) that let a **smart-link resolver** decide, *at click time and on the clicking device*, whether to open a note in a local Obsidian mirror or fall back to a deep link / online view:

1. **Presence heartbeat.** The plugin writes `wiki-meta/presence/<deviceId>.json` once at layout-ready and every 5 minutes:

   ```json
   {
     "device": "desktop-abc123",
     "vaultName": "MyVault",
     "insecurePort": 27163,
     "lastSeen": "2026-06-10T12:00:00.000Z",
     "bridgeVersion": "0.4.0"
   }
   ```

   `deviceId` is the sanitized machine hostname (or a persisted random id). The file is replicated to the server-side vault copy by [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync); the resolver reads the replicated presences to learn which devices have a live mirror and which port to probe (entries older than ~10 minutes are considered stale).

   **LiveSync requirements (load-bearing):** the path is deliberately **visible** — LiveSync does **not** replicate hidden (dot-prefixed) paths by default — and your LiveSync config must sync non-markdown files (`.json`) for the presence to reach the server.

   Toggle: Settings → MCP Router Bridge → **"Presence heartbeat (smart links)"** (default ON). Vaults that don't use smart links can switch it off; the stale presence file then simply expires server-side.

2. **`GET /ping`** — the probe target. The resolver page (an https page running on the clicking device) does `fetch('http://127.0.0.1:<port>/ping')` for each fresh presence port; the first pong wins and the page redirects to that device's `/open/<path>`. Registered as a public route (no Bearer token — a cross-origin fetch can't attach one), loopback-only like `/open`, and answering with CORS/PNA headers (`Access-Control-Allow-Origin: *`, `Access-Control-Allow-Private-Network: true`, `Access-Control-Allow-Methods: GET, OPTIONS`, `Cache-Control: no-store`).

   **Vault confirmation — optional `?v=<vault-name>`.** On a multi-vault device, every vault runs its own bridge on its own port, and a candidate port from the presence files can belong to a *different* vault than the one the link targets — a blind pong would make the resolver open the wrong note. Probing with `?v=<vault-name>` (URL-encoded) makes the pong vault-aware: the route answers `200 {"pong":true}` only if the URL-decoded name **strictly equals** this vault's name (`app.vault.getName()`), and `404` otherwise — with the same four headers, so the resolver's CORS fetch can read the status either way. Without `?v`, behavior is unchanged (bare pong). This is a *confirmation* semantic, not disclosure: the route never reveals its vault name, it only confirms a name the requester already knows (it came from the presence file / the link itself).

   **Privacy posture:** the response body is `{"pong":true}` and nothing else — no vault name, no plugin version, no port list. A prober learns only "a bridge listens on this port", which the open TCP port reveals anyway (and with `?v=`, "this port serves the vault I already named" — the 404 body is empty, nothing is echoed). Presence files contain no keys or secrets (device name, port, vault name, timestamp, version).

   `/ping` is registered on both of Local REST API's servers, but the resolver probes the **insecure (HTTP) server** port advertised by the presence file (an https page can fetch `http://127.0.0.1` — loopback is exempt from mixed-content blocking, except on Safari where the cascade falls back as designed). So `enableInsecureServer: true` must be set in Local REST API for probes to succeed (the heartbeat warns once in the console if it isn't).

## Pre-requisites in the target vault

| Plugin | Required for | Why |
|---|---|---|
| [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) | all routes | Provides the HTTPS server we register against |
| [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) | `/search/smart` only | Semantic search backend |
| [Templater](https://github.com/SilentVoid13/Templater) | `/templates/execute` only | Template engine |

Each route returns HTTP 503 with a clear error message if its dependency is missing — graceful degradation rather than crashing the bridge.

## Migration from `jacksteamdev/obsidian-mcp-tools`

If you currently have MCP Tools installed in this vault:

1. Disable MCP Tools in Settings → Community plugins.
2. Install and enable this bridge (see Install above).
3. Restart Obsidian (recommended so the route registry is rebuilt cleanly).
4. The two route paths are identical — `obsidian-mcp-router` requires no changes.
5. (Optional) Uninstall MCP Tools to remove the bundled binary from disk.

The `tp.mcpTools.prompt("key")` accessor inside Templater templates is preserved verbatim, so any templates authored against the original plugin keep working.

## API reference

### `POST /search/smart`

**Request body** (accepted as either real JSON or a JSON-stringified payload in `text/plain` — the router sends the latter):

```jsonc
{
  "query": "rules for breakeven and trailing stop",
  "filter": {
    "folders": ["Sessions", "Trades"],          // optional, restrict to these prefixes
    "excludeFolders": [".trash", "Templates"],  // optional, skip these prefixes
    "limit": 10                                  // optional, default whatever Smart Connections returns
  }
}
```

**Response** (200):

```jsonc
{
  "results": [
    {
      "path": "Sessions/2026-04-29.md#Session 2026-04-29#Trades du jour",
      "text": "...",                  // surrounding chunk content
      "score": 0.82,                  // cosine similarity, 0..1
      "breadcrumbs": "Sessions > 2026-04-29 > Session 2026-04-29 > Trades du jour"
    }
  ]
}
```

**Errors**:
- 400 — `{"error":"Invalid request body","summary":"..."}` for malformed input
- 503 — `{"error":"Smart Connections plugin is not available", "hint":"..."}` if the dependency isn't loaded

### `POST /templates/execute`

**Request body** (`application/json`, real object — NOT stringified):

```jsonc
{
  "name": "Templates/Trade.md",
  "arguments": { "ticker": "AAPL", "direction": "long" },
  "createFile": true,                              // optional, default false (preview only)
  "targetPath": "Trades/2026-05-03 - AAPL Long.md" // required if createFile is true
}
```

Inside the template, the `arguments` map is exposed at:

```js
<% tp.mcpTools.prompt("ticker") %>
```

Note: **`tp.mcpTools.prompt(...)`** — accessed directly under `tp`, NOT under `tp.user` (which is the convention for Templater user scripts). Easy footgun — copy/paste from a Templater tutorial expecting `tp.user.*` won't find anything.

**Response** (200):

```jsonc
{
  "message": "Prompt executed and file created successfully",
  "content": "# AAPL\n\n..."
}
```

**Errors**:
- 400 — invalid body (missing `name`, missing `targetPath` when `createFile: true`, etc.)
- 404 — template file not found in the vault
- 503 — Templater plugin not available, or template execution threw

## Development

```bash
npm install
npm run dev      # esbuild watch mode, rebuilds on file change
npm run build    # one-shot production build (minified, no sourcemap)
npm run deploy   # build + copy main.js + manifest.json to your reference vault's
                 #   .obsidian/plugins/mcp-router-bridge/ folder
```

The build emits `main.js` at the repo root. Combined with `manifest.json`, that's all Obsidian needs.

`npm run deploy` finds your reference vault by reading `referenceVault` from
`~/.claude/obsidian-mcp-router/config.json` (the [obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router)
config file). Set the `OBSIDIAN_TEMPLATE_VAULT` environment variable to override.

After deploying, propagate to vaults that already have the plugin installed:

```bash
# For each consumer vault — re-clones plugins, preserves data.json:
node "<obsidian-mcp-router>/scripts/setup-vault.mjs" "<vault>" --sync-plugins --force
```

Then disable+re-enable the plugin in each Obsidian instance, or run "Reload app without saving" from the command palette.

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). No usage restrictions.
