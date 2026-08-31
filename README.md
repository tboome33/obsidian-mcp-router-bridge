# obsidian-mcp-router-bridge

A minimal Obsidian community plugin that adds six REST routes to the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin:

| Route | Auth | Delegates to | Used by |
|---|---|---|---|
| `POST /search/smart` | Bearer | [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) — semantic search via vector embeddings | `obsidian-mcp-router` `search_smart` tool |
| `POST /templates/execute` | Bearer | [Templater](https://github.com/SilentVoid13/Templater) — render a template, optionally write to a new file | `obsidian-mcp-router` `execute_template` tool |
| `PUT /vault-cas/<path>` | Bearer | Obsidian's vault adapter — compare-and-swap write, refused if the file changed since you read it | `obsidian-mcp-router` writes with `ifMatch` |
| `GET /smart-env/sources` | Bearer | Obsidian's vault adapter — serves Smart Connections' whole-note vector records, which live in a dot-directory the Local REST API will not serve | `obsidian-mcp-router` `find_twin_pages`, on a **remote** vault — see [Vector store](#vector-store-smart-envsources) |
| `GET /open/<path>` | **None** (loopback-only, public route) | Obsidian's `workspace.openLinkText` — navigate to a vault file | Click-to-open links from Claude Code chat / any client emitting clickable http URLs |
| `GET /ping` | **None** (loopback-only, public route) | Nothing — returns a bare `{"pong":true}`; optional `?v=<vault-name>` answers 404 unless the name matches this vault | Smart-link resolver pages probing for a local mirror — see [Presence heartbeat + /ping](#presence-heartbeat--ping-smart-links) |

It also runs a **presence heartbeat** that advertises this device as an active local mirror — see [Presence heartbeat + /ping](#presence-heartbeat--ping-smart-links) — and can **hide chosen folders in the file explorer** (cosmetic, per-vault) — see [Settings](#settings).

## Where this sits in the stack

The bridge is one layer in a four-piece chain:

```
Obsidian  ←  Local REST API (community plugin)  ←  BRIDGE (mcp-router-bridge, this plugin)
    ↑ HTTP per-vault (port + apiKey from the Local REST API plugin)
MCP SERVER (obsidian-mcp-router) — Node process on the PC
    ↑ MCP over stdio, spawned by Claude Code
CLAUDE CODE PLUGIN (obsidian-router) — commands + skills + agents + hooks
```

- **What the bridge needs:** Obsidian + the [Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. The bridge runs entirely *inside* Obsidian and registers its extra routes (`/search/smart`, `/templates/execute`, `/open/*`, `/ping` + the presence heartbeat) on Local REST API's HTTP server.
- **Who needs the bridge:** the [`obsidian-mcp-router`](https://github.com/tboome33/obsidian-mcp-router) MCP server — its `search_smart` and `execute_template` tools and its click-to-open links all land on bridge routes. That server is spawned by Claude Code: since router v0.56.1 it is shipped and launched by the `obsidian-router` Claude Code plugin (one install = everything), or hand-registered in `~/.claude.json` on dev setups.
- **What breaks without the bridge:** smart (semantic) search, Templater execution, and clickable open-in-Obsidian links. The server's core file CRUD keeps working — those tools use Local REST API's native routes and never touch the bridge.
- **How it updates:** via [BRAT](https://github.com/TfTHacker/obsidian42-brat) from this repo's GitHub releases (see [Install](#install)); the router's reference `.template` vault also carries a vendored copy that `setup-vault.mjs` / `npm run deploy:all` propagate to dev fleets.

## Why this exists

The companion router project [`obsidian-mcp-router`](https://github.com/tboome33/obsidian-mcp-router) needs the REST routes Local REST API doesn't ship natively — `/search/smart`, `/templates/execute`, `GET /open/*`, `GET /ping` — to expose semantic search, Templater execution and click-to-open links through its MCP tools. This plugin adds them on top, in the smallest, most boring way possible. Without the bridge, the router's core file CRUD still works over plain Local REST API routes; smart search, Templater execution and clickable links do not.

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

### Normal path — GitHub releases via BRAT

- **With `obsidian-mcp-router`** (the common case): the bridge is installed for you. `node scripts/setup-vault.mjs` provisions [BRAT](https://github.com/TfTHacker/obsidian42-brat) in the vault and downloads the bridge from this repo's GitHub releases; BRAT then keeps it auto-updated at Obsidian startup. The router's `/sync-from-github` command (router v0.55.0+) syncs one vault or the whole fleet the same way, with a BRAT anti-downgrade guard.
- **Standalone** (no router): install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from the community plugins marketplace, then add `tboome33/obsidian-mcp-router-bridge` as a beta plugin — BRAT fetches the latest GitHub release and auto-updates it thereafter.

### Manual build (dev / offline fallback)

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

## Vector store (`/smart-env/sources`)

`GET /smart-env/sources` — **Bearer-authenticated**, added in v0.9.0.

### Why it exists

[Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) keeps one vector per note under `<vault>/.smart-env/multi/`. The Local REST API does not serve dot-directories, and that is structural rather than a setting: measured on a real vault, Obsidian's own `app.vault.getFiles()` returns **zero** entries under `.smart-env`, so nothing in the core API can even see them. A plugin can, through `vault.adapter` — which is the whole reason this route lives here.

It exists so the companion router's `find_twin_pages` (all-pairs cosine over a wiki) can run against a vault on **another machine**. On the machine that has the vault, the router reads the same files off disk and does not call this.

### What it sends, and what it deliberately does not do

The response is NDJSON: a header line, then the store's own whole-note record lines, verbatim, in sorted-filename order.

```
{"kind":"smart-env-sources","storePath":".smart-env/multi","available":true,"files":803,…}
"smart_sources:wiki/a.md": {…},
"smart_sources:wiki/b.md": {…},
```

**The bridge does not parse a record, resolve a tombstone, apply last-wins, choose a model, or look at a single vector.** It keeps the lines starting with `"smart_sources:` and drops the rest — which is not a guess about the format but a restatement of the consumer's own first step. All the meaning stays in one place, on the router side, so the local and remote paths cannot drift apart. Verified over 1046 store files on four vaults: parsing the full text and parsing the filtered text yield identical record maps.

The filter is worth doing because the discarded lines are `smart_blocks:` chunks, which are ~96% of the bulk. On this project's vault: **166 MB on disk → 22.3 MB sent → 4.3 MB on the wire** once gzip is negotiated (it is, automatically, whenever the client advertises it).

### Two contract details that matter to a client

- **This route never answers 404.** A vault with no Smart Connections is an ordinary answer — a `200` whose header reads `"available": false, "reason": "store-missing"`. So a real `404` means one thing only: *the route is not there*, i.e. an older bridge. Same discipline as `/vault-cas`.
- **Truncation is loud.** The route bounds what one request will read. If it stops early the header says `"truncated": true` with `truncatedBy`, and `filesRead` counts only the files the body actually represents. A partial store must not be mistakable for a small vault — the router refuses to compare one.

### Security

`addRoute`, not `addPublicRoute`: the Bearer check applies, because this returns vault-derived data and belongs behind the same key as reading the notes. **The route takes no path parameter** — the store directory is a module constant, so there is nothing to traverse out of and no guard to get wrong. That is deliberate: a general "read a dot-file" route would hand out `.obsidian/plugins/obsidian-local-rest-api/data.json`, which holds the Bearer key itself.

## Click-to-open

`GET /open/<vault-relative-path>` opens a file in Obsidian when hit. **No Bearer token required** — this is a `addPublicRoute()` registration (requires Local REST API ≥ 4.0.0 — see [Requirements](#requirements)). Designed for surfacing wiki pages from clients that emit clickable http(s) links (Claude Code CLI, browsers, etc.) where `obsidian://` URIs aren't dispatched.

### How to use

```
https://127.0.0.1:<port>/open/<URL-encoded-vault-path>
```

Example for `wiki/references/router-agents.md` in a vault whose Local REST API runs on port 27132:

```
https://127.0.0.1:27132/open/wiki%2Freferences%2Frouter-agents.md
```

A click → browser GETs the URL → bridge calls `app.workspace.openLinkText` → Obsidian navigates to the file → browser tab shows a tiny "Opened in Obsidian" page that attempts to auto-close (browser-dependent).

Two optional query parameters (v0.3.0+):

- `?h=<heading text>` — scroll to and highlight that heading after opening (the Obsidian-native `[[note#heading]]` behavior). Silently ignored if the heading doesn't exist. It must travel as a **query param**, never a `#fragment` — browsers strip fragments before sending the request, so the bridge would never see it.
- `&reveal=0` — skip revealing/selecting the note in the file-explorer treeview (the reveal is ON by default).

### Bring Obsidian to the front (foreground on click) — v0.5.0+

By default, clicking an http `/open` link foregrounds your **browser**, not Obsidian — the note opens correctly but in the background. This is the **Windows foreground-activation lock**, not a fixable Electron quirk: a background app cannot steal the foreground from the browser that just received the click (`app.focus({steal:true})` is "give focus, never *take* it" by design; `setAlwaysOnTop`/`moveTop`/`minimize`+`restore` only reorder z-order — all empirically confirmed to fail against a freshly-clicked Chrome). The bridge always calls `flashFrame(true)` so the taskbar icon blinks, and on macOS/Linux a best-effort `app.focus()` does bring the window forward — but on Windows the only reliable, native-code-free way to foreground Obsidian is to let the **OS protocol handler** do it.

**Enable it in two steps (Windows):**

1. **Plugin setting** — Settings → MCP Router Bridge → **"Bring Obsidian to the front on /open (obsidian:// redirect)"** (default **OFF**, per-vault — enable it in each vault where you want foreground-on-click). When ON, the `/open` response page redirects to `obsidian://open?vault=<this-vault>` (vault-only — it just *focuses* the already-navigated window, it never re-navigates). The OS — not the background renderer — performs the activation, bypassing the foreground lock.

2. **Chrome policy** — without this, Chrome shows an "Open Obsidian?" dialog on *every* click (the per-site "always allow" checkbox was removed in Chrome 77). Pre-authorize `obsidian://` from loopback origins with `AutoLaunchProtocolsFromOrigins`, set it once (no admin needed for the per-user hive), then **restart Chrome** so it loads the policy:

   ```powershell
   # Windows, per-user (HKCU). The :* wildcard covers every vault's bridge port.
   New-Item -Path 'HKCU:\SOFTWARE\Policies\Google\Chrome' -Force | Out-Null
   New-ItemProperty -Path 'HKCU:\SOFTWARE\Policies\Google\Chrome' `
     -Name 'AutoLaunchProtocolsFromOrigins' -PropertyType String -Force `
     -Value '[{"protocol":"obsidian","allowed_origins":["http://127.0.0.1:*"]}]' | Out-Null
   ```

   (Machine-wide: same value under `HKLM\…\Policies\Google\Chrome` — needs admin. Edge: `…\Policies\Microsoft\Edge`. Verify at `chrome://policy` after the restart.)

   > ⚠️ **The policy is origin-scoped, not bridge-specific.** It pre-allows `obsidian://` launches from *any* `http://127.0.0.1` page in that browser profile, not just this bridge. Residual risk is low — `obsidian://` is navigation-only and any local process can already invoke it via the OS shell — but it's broader than the one route. To scope it tightly, replace `http://127.0.0.1:*` with the exact bridge origins (one per vault port, e.g. `http://127.0.0.1:27163`).

With both in place, clicking a click-to-open link foregrounds Obsidian silently — zero extra clicks. Leave the setting OFF (the default) if you'd rather not set a browser policy: the note still opens in the background and the taskbar flashes.

### Security model

- **Loopback-only.** Local REST API binds 127.0.0.1 by default; the handler additionally checks `req.ip` as defense-in-depth and refuses non-loopback requests.
- **No auth.** The scope is intentionally minimal — navigation only, no content read, no write, no execution. Other processes running locally as the same user could already read the vault directly via the filesystem; this route doesn't expand their attack surface.
- **Path traversal refused.** `..` segments, absolute paths, Windows drive letters all return 403.
- **Resolution contract (v0.5.1+).** Exact path first. On a miss, the handler falls back to a **unique basename match** across the vault — a correct filename in the wrong folder still opens the right note, mirroring Obsidian's own `[[wikilink]]` resolution (the fallback never escapes the vault; the resolved file is opened by verified reference). Zero matches → 404. Two or more matches → 409 listing the candidate paths — the bridge never silently picks one. Folders resolve by exact path only. See `src/handlers/open-resolve.mjs`.

Why no Bearer token: a click navigation cannot attach an `Authorization` header, and embedding the token into the URL would expose it in browser history and clipboard. Localhost + minimal scope makes the unauth registration the right trade-off here.

### HTTPS cert warning

Local REST API ships HTTPS with a self-signed cert by default. First click per port shows a browser warning ("Not Secure / Advanced / Continue"). Subsequent clicks within the same browser session are fine. To eliminate the warning, enable the **HTTP server** in Settings → Local REST API and use that port instead of the HTTPS one.

### Requirements

- `mcp-router-bridge` ≥ v0.2.0 installed and enabled in the vault.
- Local REST API ≥ 4.0.0 — the version the router's `/meta-audit-bridge-readiness` command checks for; it must expose `addPublicRoute()`. If `addPublicRoute()` is unavailable, the bridge logs a warning at load and skips **both** public routes (`/open/*` and `/ping`); the two Bearer routes (`/search/smart`, `/templates/execute`) still work normally.

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

## Settings

Settings → Community plugins → **MCP Router Bridge**. Every setting is stored in that vault's own `.obsidian/plugins/mcp-router-bridge/data.json`, so **it is per-vault** — nothing is shared between vaults, and the same plugin build can behave differently in each one.

| Setting | Default | What it does |
|---|---|---|
| **Presence heartbeat (smart links)** | ON | Writes `wiki-meta/presence/<device>.json` every 5 minutes so smart-link resolvers can detect this device as a live local mirror — see [Presence heartbeat + /ping](#presence-heartbeat--ping-smart-links) |
| **Bring Obsidian to the front on /open** | OFF | Redirects the `/open` response page to `obsidian://` so the OS foregrounds Obsidian. Needs a one-time Chrome policy — see [Bring Obsidian to the front](#bring-obsidian-to-the-front-foreground-on-click--v050) |
| **Hide folders in the file explorer** | OFF | Master switch for the cosmetic hiding below |
| **Folders to hide** | `wiki-meta` | One vault-relative folder path per line |
| **Check the wiki navigation indexes when this vault opens** | OFF | Detection-only conformance check — see [Navigation index check](#navigation-index-check-on-vault-open) |
| **Navigation index status** | — | Read-only line showing the last check's result |

### Hide folders in the file explorer — v0.6.0+

Keeps housekeeping folders out of sight in the file-explorer sidebar. Typical use: the private `wiki-meta` scaffold folder (`hot`, `catalog`, `journal`, `presence/`) is machinery you rarely open by hand, and it sits at the top of every vault.

Turn on **"Hide folders in the file explorer"** and list the folders, one vault-relative path per line:

```
wiki-meta
Archive/2024
```

The folder, its sub-folders and its files all disappear from the tree. Changes apply **instantly** — no restart, no reload. Because the setting is per-vault, hiding can be on in a shared or kids' vault and off in your working vaults, with no shared configuration.

**Strictly cosmetic — and that is the whole design.** The only thing the plugin does is inject one `<style>` element (`id="mcp-router-bridge-hidden-folders"`) into the app window, keyed on the `data-path` attribute Obsidian puts on every explorer row:

```css
.nav-folder:has(> .nav-folder-title[data-path="wiki-meta"]) {
  display: none !important;
}
.nav-folder-title[data-path="wiki-meta"],
.nav-folder-title[data-path^="wiki-meta/"],
.nav-file-title[data-path^="wiki-meta/"] {
  display: none !important;
}
```

Nothing else changes. The folder is **not renamed**, **not moved**, and **not dot-prefixed**, and nothing is written to the vault. So all of this keeps working exactly as before:

- **The Local REST API** — and therefore `obsidian-mcp-router`, which reads `wiki-meta/hot.md`, `catalog.md` and `journal.md` on nearly every call.
- Obsidian's **indexing**, **search**, **graph**, **quick switcher**, **backlinks** and `[[wikilinks]]`.
- The **presence heartbeat**, which writes into `wiki-meta/presence/`.

> ⚠️ **Why not just rename it `.wiki-meta`?** Because Obsidian ignores dot-prefixed folders entirely — which makes them invisible to the Local REST API too, so the MCP router would stop being able to read `wiki-meta` at all. A dot-folder is the one approach that looks equivalent and quietly breaks the whole stack. Hiding therefore lives in the stylesheet, where the REST surface cannot observe it.

Two CSS rules are emitted rather than one: the `:has()` rule removes the whole subtree in one go on current Obsidian builds, and the row-by-row rule is a fallback for older Electron versions whose Chromium predates `:has()` (`minAppVersion` is 1.0.0). They are deliberately kept in **separate blocks** — a browser that can't parse `:has()` discards the entire rule containing it, so merging the selector lists would take the fallback down with it. Both paths are verified against a real Chromium; see `tests/folder-hiding-core.test.mjs`.

Hiding is visual only, so a hidden folder can still be reached deliberately — via the quick switcher, search, a `[[wikilink]]`, or a click-to-open link. That is intentional: this is tidying, not access control.

**Optional complement — Obsidian's native "Excluded files".** Settings → Files & Links → *Excluded files* takes the folder out of **search results, the graph and link suggestions** (it de-emphasises rather than hides, and the folder stays in the explorer). It is independent of this plugin and safe to combine: unlike a dot-folder, exclusion does not hide the folder from the Local REST API, so the router keeps working. Use the bridge setting to clear the sidebar, and "Excluded files" as well if you also want the folder out of your search results.

### Navigation index check on vault open

A vault managed by `obsidian-mcp-router` carries a set of **generated** navigation files under `wiki/`: a root `index.md`, one `index.md` in every folder on the way to a content page, and a newest-first `log.md`. Each one opens with a marker line — `> Generated by obsidian-mcp-router …`.

"Managed" is a precise claim, not a guess: the check only applies to a vault carrying the router's private scaffold, `wiki-meta/catalog.md` (or `wiki-meta/index.md` on a vault that predates the rename). A hand-made folder called `wiki` in a vault the router has never touched is **not** a router vault, gets no Notice, and is not even read.

They are written by the router, and the router only runs when something calls it. Nothing at all ran when you merely *opened* a vault — so a vault whose indexes were never built, or that drifted after you created folders by hand, looked entirely fine until something far away misbehaved.

Turn on **"Check the wiki navigation indexes when this vault opens"** and the plugin looks once, when the vault finishes loading, and tells you what is missing:

> MCP Router Bridge — index de navigation incomplets dans wiki/ · 2 manquant(s) : wiki/notes/index.md, wiki/log.md. Ce plugin ne génère rien : lancez `refresh_okf_projections` côté routeur…

The same result is spelled out in the **Navigation index status** line in settings, where there is room to also say "conformant" or "this vault has no `wiki/` content".

**Detection only — that is the entire design, and it is deliberate.** There is exactly ONE implementation of the generator and it lives in the router (shared with its OKF bundle exporter). A TypeScript port living here would be a *second* implementation, shipping on a different release train, diverging the first time either side was fixed — and both would be writing the same files. So this plugin recognises a generated file and notices one is missing. It has no content builder, it never creates, edits or deletes anything, and opening a vault never mutates it.

Repairs come from the router side, either way you like:

- run `refresh_okf_projections` (and `build_search_index`) explicitly, or
- just open a Claude session on that vault — the router repairs on its first contact of the session.

**Off by default, on purpose.** This plugin auto-updates through BRAT. A Notice that started appearing by itself in every vault after an upgrade would be an unannounced change, so — like the folder-hiding switch — you opt in per vault. Turning it on runs the check immediately rather than waiting for the next vault load, and the **Re-check** button beside the status line re-runs it once you have fixed something.

**Cost.** One pass at layout-ready, never repeated. The file list comes from Obsidian's in-memory index (free); each expected navigation file that is present is then read to confirm its marker, **8 at a time** so a large vault does not stall the UI thread. An unmarked `wiki/a/index.md` matters as much as an unmarked root one — the router treats it as a conflict it refuses to overwrite, so a check that only looked at the root would call the vault conformant while the router reported a problem with the same file.

**Three states, never conflated.** *Conformant*, *incomplete*, and *not a router-managed vault* — plus a fourth, *the check itself failed*, which is what you see when a file could not be read. A failure is never reported as a clean bill of health, and it never becomes a Notice; it is logged to the console once and shown in the status line.

**The status line also reports whether `wiki-meta/search-index.json` exists** — presence only. Its version and its freshness are the router's business, and reading it here would be this plugin forming an opinion it has no way to act on.

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

**Response** (200, `createFile: true`):

```jsonc
{
  "message": "Prompt executed and file created successfully",
  "content": "# AAPL\n\n...",
  "path": "Trades/2026-05-03 - AAPL Long.md"  // vault path of the created file
}
```

**Response** (200, preview mode — `createFile` absent or `false`):

```jsonc
{
  "message": "Prompt executed without creating a file",
  "content": "# AAPL\n\n..."
}
```

**Errors**:
- 400 — invalid body (missing `name`, missing `targetPath` when `createFile: true`, etc.). Note that `createFile` must be a **real JSON boolean**: a stringified value like `"false"` is rejected with 400 on purpose (strings would otherwise be silently truthy).
- 404 — template file not found in the vault
- 409 — `{"error":"Target path already exists","summary":"..."}` — the handler refuses to overwrite an existing `targetPath`
- 503 — Templater plugin not available, or template execution threw

## Development

```bash
npm install
npm run dev         # esbuild watch mode, rebuilds on file change
npm run build       # tsc (type-check) + esbuild production build; the `postbuild`
                    #   hook then auto-deploys main.js + manifest.json + a
                    #   `.hotreload` marker to your reference vault's
                    #   .obsidian/plugins/mcp-router-bridge/ folder
npm run deploy      # alias of `npm run build` (build already deploys)
npm run deploy:all  # build + propagate to every registered vault
                    #   (runs the router's setup-vault.mjs --sync-all --force)
npm test            # node --test tests/*.test.mjs
```

The build emits `main.js` at the repo root. Combined with `manifest.json`, that's all Obsidian needs. The `.hotreload` marker (v0.5.0+) lets [pjeby's Hot Reload](https://github.com/pjeby/hot-reload) plugin live-reload the bridge in the reference vault after each build — no manual toggle.

The deploy step finds your reference vault by reading `referenceVault` from
`~/.claude/obsidian-mcp-router/config.json` (the [obsidian-mcp-router](https://github.com/tboome33/obsidian-mcp-router)
config file). Set the `OBSIDIAN_TEMPLATE_VAULT` environment variable to override.

To propagate to the rest of a dev fleet, `npm run deploy:all` does it in one command (equivalent to running `node "<obsidian-mcp-router>/scripts/setup-vault.mjs" --sync-all --force` yourself — re-clones plugins, preserves each vault's `data.json`). Then disable+re-enable the plugin in each Obsidian instance, or run "Reload app without saving" from the command palette. Consumer vaults without a dev checkout don't need any of this: they update via BRAT from GitHub releases (or the router's `/sync-from-github`) — see [Install](#install).

## License

Apache 2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE). No usage restrictions.
