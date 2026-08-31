# Changelog

All notable changes to `mcp-router-bridge` (the Obsidian community plugin) are documented here. Format roughly follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning is [SemVer](https://semver.org/).

## [Unreleased]

Nothing pending right now.

> **Gap, noted rather than invented:** `0.7.0` (`PUT /vault-cas`) and `0.8.0`
> (conformance detection) shipped and are in `versions.json`, but were never
> written up here. Reconstructing them from commits after the fact would be a
> guess dressed as a record, so they are left missing and flagged instead.

## [0.9.0] — 2026-08-31 — `GET /smart-env/sources`: the vector store the REST API refuses to serve

[Smart Connections](https://github.com/brianpetro/obsidian-smart-connections) keeps one vector per note under `<vault>/.smart-env/multi/`. The Local REST API does not serve dot-directories, so the companion router's `find_twin_pages` — all-pairs cosine over a wiki — worked only on a vault whose disk the router could reach, and answered `available: false, reason: "remote-vault"` for anything else.

That refusal turns out to be **structural, not a setting**: measured on a real vault, Obsidian's own `app.vault.getFiles()` returns **zero** entries under `.smart-env`. Its file index does not carry them either. A plugin can still read them through `vault.adapter` — which is exactly why the fix belongs here and not in the router.

### Added

- **`GET /smart-env/sources`** (`addRoute`, so the Bearer check applies — this is vault-derived data and belongs behind the same key as reading a note). Responds NDJSON: a header line, then the store's whole-note record lines verbatim, in sorted-filename order.

- **`src/handlers/smart-env-core.mjs` — the pure half**, adapter injected, so the whole contract is testable with no Obsidian at all.

### The one thing this route deliberately does NOT do

It does not parse a record, resolve a tombstone, apply last-wins, choose a model, or look at a vector. It keeps the lines beginning with `"smart_sources:` and drops the rest — which is not a guess about the format, but a restatement of the consumer's own first step. Every question of *meaning* stays on the router side, so the local-disk and remote paths cannot drift: they agree **by construction**, not by a parity test that only notices a divergence after someone writes it.

Verified over 1046 store files on four vaults: parsing the full text and parsing the filtered text produce identical record maps — 0 divergences. And the filter earns its place, because the discarded `smart_blocks:` lines are ~96% of the bulk:

| | this project's vault |
|---|---|
| store on disk | 166.1 MB |
| whole-note records only | 22.3 MB |
| **gzipped on the wire** | **4.31 MB** |

Compression is negotiated (`Accept-Encoding`), never assumed, and runs **async** — the synchronous call costs ~300 ms on that payload, and this is Obsidian's UI thread.

Measured end to end against the live plugin: 803 store files → 1310 records → 805 pages, and the router's disk backend and this route return **identical vectors, path for path** (0 missing, 0 differing).

### Two contract rules, both borrowed from `/vault-cas`

- **This route never answers 404.** A vault with no Smart Connections gets a `200` whose header says `"available": false, "reason": "store-missing"`. That leaves `404` meaning exactly one thing — *the route is absent*, i.e. an older bridge — which the router reports as `bridge-route-absent` with something the operator can actually do.
- **Truncation is loud.** The route bounds one request and the header carries `truncated` + `truncatedBy` when it bites. `filesRead` counts only files the body actually represents — not files whose bytes were fetched and then discarded. A first draft got that wrong and reported `filesRead === files` beside `truncated: true`, a contradiction the reader had no way to resolve; the test that caught it is now the one that pins it.

### Three budgets, because they bound different things

| budget | default | bounds |
|---|---|---|
| `maxBytes` | 64 MB | the RESPONSE |
| `maxReadBytes` | 512 MB | what passes through the renderer's memory to build it |
| `maxFiles` | 20 000 | files ATTEMPTED |

They are not interchangeable, and review round 2 found each of the first drafts of them wrong in a different way. The response budget says nothing about what was read: the filter discards ~96% of every file, so 22 MB sent cost 166 MB read. Both were measured in `string.length` — UTF-16 code units, not the bytes they are stated in, which on a fleet full of accented vault paths is a budget that quietly lets through more than it promises. And `maxFiles` guarded on `filesRead`, which only advances on success, so a directory of unreadable entries was walked in full while the header said `truncated: false` — a runaway guard that guarded nothing.

`maxReadBytes` is documented as a **floor-stop**: it is checked before the next read, so the total can overshoot by at most one file. It cannot be tighter, because a file's size is not known until it has been read.

### The header is a claim, and the consumer checks it

`recordLines` and `bytes` are exact, because the router verifies both against the body that actually arrived and refuses (`store-inconsistent`) on a mismatch. That is what catches a body cut mid-record: the truncated line still starts with the prefix, so a line count alone would not notice. The producer's `bytes` was off by one at first — `segments.join('\n')` puts n−1 newlines between n segments, not n — which the consumer's check would have rejected on every single valid response.

### Security

The route **takes no path parameter** — the store directory is a module constant, so there is nothing to traverse out of and no guard to get wrong. That is the point: a general "read a dot-file" route would hand out `.obsidian/plugins/obsidian-local-rest-api/data.json`, which holds the Bearer key itself.

### Tests

`tests/smart-env-core.test.mjs` — 17 cases covering the anchored prefix test (against block records that *contain* the marker in their own payload), sorted read order, the header's inertness to the consumer's parser, unreadable files counted but never fatal, all three truncation modes landing on a file boundary, byte-exact accounting on a multi-byte fixture, the file guard stopping actual read attempts, and the balance `filesRead + unreadableFiles === files` on an untruncated read.

## [0.6.0] — 2026-07-30 — hide folders in the file explorer (cosmetic, per-vault)

The private `wiki-meta` scaffold folder (`hot`, `catalog`, `journal`, `presence/`) is machinery, not reading material, yet it sits at the top of every vault's sidebar. This adds a setting to hide chosen folders from the file explorer — and hides them **only there**.

The obvious shortcut, renaming the folder to `.wiki-meta`, is exactly what this must not do: Obsidian ignores dot-prefixed folders entirely, which makes them invisible to the Local REST API too, so the MCP router would silently lose `wiki-meta` — the folder it reads on nearly every call. The mechanism is therefore confined to a stylesheet, where the REST surface cannot observe it. (Volet ③ of the upstream `catalog-journal-et-projections-okf` decision, 2026-07-30; volets ① and ② are router-side and independent.)

### Added

- **`hideFoldersEnabled` (default OFF) + `hiddenFolders` (default `['wiki-meta']`) settings**, with a Settings toggle *"Hide folders in the file explorer"* and a *"Folders to hide"* textarea (one vault-relative path per line). Both live in the vault's own `data.json`, so hiding can be ON in a shared or kids' vault and OFF in working vaults with **no shared configuration**. Changes apply **instantly** — the stylesheet is recomputed on every `onChange`, no restart or reload.

  Default OFF on purpose: the bridge auto-updates through BRAT, and a feature that made folders vanish from the explorer on upgrade would be a surprising, unannounced UI change in every existing vault. The list ships pre-filled so opting in is one click. Same posture as `foregroundViaProtocol` in v0.5.0.

- **`src/folder-hiding.ts` — `FolderHidingManager`.** Owns a single `<style id="mcp-router-bridge-hidden-folders">` in `document.head`, whose content is recomputed from the settings. Teardown via `register()` so Obsidian drops the stylesheet on unload (without it, a disabled plugin would keep hiding folders until restart); a stale element from a previous instance is reaped before injecting, so Hot Reload can't leave duplicates. Failure posture matches the presence heartbeat: a throwing DOM call is logged, never fatal — and it fails toward *visible*, the safe direction for a cosmetic feature.

- **`src/folder-hiding-core.mjs` — the pure half** (same `allowJs` pattern as `open-params.mjs`, so the test suite runs it on the Node 20 baseline): `normalizeFolderPath`, `parseFolderList`, `escapeCssStringValue`, `buildHiddenFoldersCss`.
  - Input is normalized to the shape Obsidian actually puts in `data-path`: Windows-style `wiki-meta\presence` is folded to `/`, duplicate and leading/trailing separators are stripped, `.`/`..` segments are dropped (they can only be typos — `data-path` never contains them), and entries are deduped.
  - The list is split on **newlines only, never commas** — `Notes, misc` is a legal Obsidian folder name, and splitting it would make that folder impossible to express.
  - The folder list is user input that ends up **inside a CSS selector**, so it is escaped at the boundary: `"` and `\` are backslash-escaped and control characters become CSS hex escapes. Without that, `wiki"] {} body {display:none} [x="` would close the attribute value and restyle the whole app. Same encode-at-the-boundary posture as `open-html.mjs`.

- **README "Settings" section** — tabulates all four settings, documents the new one (what it does *not* touch: REST API, indexing, search, graph, wikilinks, the presence heartbeat), spells out the dot-folder trap, and points at Obsidian's native **"Excluded files"** as an optional, independent complement (takes the folder out of search/graph/link suggestions; unlike a dot-folder it stays visible to the REST API, so it is safe to combine).

### Tests

- **`tests/folder-hiding-core.test.mjs` (29 tests)** — 94 total (was 65). Covers normalization, newline-vs-comma splitting, dedup, poisoned settings values (`null` / number / object never throw), CSS-string escaping incl. backslash-before-quote ordering, and the emitted stylesheet.
  - Two injection tests assert the real invariant rather than a proxy: string literals are stripped from the output (honouring escapes) and the remaining *structure* must still contain exactly two rule blocks with the payload nowhere in it. Counting raw braces would have failed for the wrong reason — `{` inside a CSS string is inert.
  - One test pins the **separate-blocks invariant**: the `:has()` selector and the row fallback must never share a rule block, because a Chromium that can't parse `:has()` discards the whole rule it appears in — which would take the fallback down on exactly the old builds that need it.
  - Selector semantics were additionally verified against a real Chromium on a fixture replicating the explorer DOM: with `:has()` the whole subtree goes; with that rule deleted (simulating old Electron) the row fallback still hides every descendant; and the near-miss sibling `wiki-meta-archive` stays visible in both — the `^="wiki-meta/"` prefix does not over-match.

### Changed

- `loadSettings()` now normalizes `hiddenFolders` through `parseFolderList()` at load, so the rest of the plugin can assume a clean `string[]`: a hand-edited or sync-poisoned `data.json` could carry a bare string or `null` there, and the settings tab calls `.join()` on it. (Same defensive posture as the `deviceIdFallback` re-sanitization in v0.4.0.)

### Migration

- Pull, `npm install`, `npm run build` (deploys to `.template`), then `npm run deploy:all` and reload Obsidian once per running instance (or rely on Hot Reload). **No behavior changes on upgrade** — the setting is OFF by default; enable it per vault. No route, schema or presence change.

## [0.5.1] — 2026-07-14 — `/open` self-heals a wrong-folder path by basename (never guesses)

A click-to-open URL whose path had the right filename but the wrong folder used to 404: the handler resolved via `getAbstractFileByPath(exactPath)` (strict) and gave up. Obsidian itself resolves `[[wikilinks]]` by basename, so the same click via `obsidian://` worked while the bridge's http `/open` didn't — a confusing dead link. This closes that gap at the point of use.

### Changed

- **`/open/<path>` falls back to a UNIQUE basename match when the exact path misses.** New pure helper `src/handlers/open-resolve.mjs::resolveOpenTarget()`: exact path first (files + folders); on a miss, enumerate `vault.getFiles()` and keep TFiles whose leaf name matches. Exactly one → open that verified TFile (self-healing, `corrected`). Zero → 404. **Two or more → 409** with the candidate paths, listed — the bridge NEVER silently picks one (deliberately avoids `metadataCache.getFirstLinkpathDest`, which hides ambiguity by returning a "first" hit). Folders resolve by exact path only (a basename fallback across folders is too ambiguous). Security unchanged: the basename is derived from the already traversal-guarded path, the enumeration never escapes the vault, and the resolved file opens by verified reference. Heading scroll + folder open now use the RESOLVED file's own path (not the requested one). 9 unit tests in `tests/open-resolve.test.mjs`.
- Complements obsidian-mcp-router v0.45.0, where `build_open_link` verifies the path on disk BEFORE emitting a URL (fail-closed at generation). Together: the router won't emit an unverified URL, and the bridge heals a slightly-wrong one at click time.

## [0.5.0] — 2026-06-18 — `/open` foreground via `obsidian://` opt-in + Hot Reload live-reload marker

The focus-steal work of v0.3.1/v0.3.2 (`app.focus({steal})` + `setAlwaysOnTop` dance) **never actually worked on Windows** — confirmed this release across an exhaustive empirical investigation (a multi-model panel + parallel web research + headless A/B tests driving real Chrome clicks and measuring window activation). Root cause: the **Windows `SetForegroundWindow` activation policy**, not an Electron gap. A background app cannot steal the foreground from the browser that just received the click; `app.focus({steal:true})` is "give focus, never take it" by design ([electron#10783](https://github.com/electron/electron/pull/10783)), and `setAlwaysOnTop`/`moveTop`/`minimize`+`restore` only reorder z-order. The only non-native fix that works: hand off to the **OS protocol handler** via an `obsidian://` redirect.

### Added

- **`foregroundViaProtocol` setting (default OFF)** + Settings toggle *"Bring Obsidian to the front on /open (obsidian:// redirect)"*. When ON, the `/open` response page redirects to `obsidian://open?vault=<this-vault>` (vault-only — it just *focuses* the already-navigated window, never re-navigates). The OS shell performs the activation, bypassing the foreground lock. OFF by default because, without a one-time Chrome `AutoLaunchProtocolsFromOrigins` policy pre-allowing `obsidian://` from `http://127.0.0.1`, Chrome prompts *"Open Obsidian?"* on every click (the per-site "always allow" checkbox was removed in Chrome 77). With the policy, the redirect fires silently — zero extra clicks. Full setup (incl. the origin-scoped-policy caveat) in the README "Bring Obsidian to the front" section.
- **`.hotreload` marker on deploy.** `deploy.mjs` now drops an empty `.hotreload` file into the deployed bridge folder so pjeby's [Hot Reload](https://github.com/pjeby/hot-reload) plugin (if installed) live-reloads the bridge whenever `main.js` changes — i.e. on every `deploy:all`, no manual "Reload app" per Obsidian instance. The marker propagates to consumer vaults via the router's `setup-vault.mjs` recursive copy. Wrapped in try/catch so a failed write degrades gracefully. (Router side — `hot-reload` added to `OPTIONAL_PLUGINS` — ships in obsidian-mcp-router v0.32.0.)

### Changed

- **`/open` foreground rewrite.** Removed the non-working `app.focus({steal})` + held-`setAlwaysOnTop` re-raise dance. The handler now always calls `flashFrame(true)` (the Windows-sanctioned "needs attention" taskbar blink, auto-cleared on activation; cleanup listener guarded against per-click accumulation) plus a best-effort `app.focus()`/`show()`/`focus()` that DOES foreground on macOS/Linux and is a harmless no-op on Windows. The actual Windows foreground path is the opt-in `obsidian://` redirect above.
- **`makeOpenHandler(app, foregroundViaProtocol?)`** gained an optional getter param (back-compatible — existing call sites are unaffected).

### Tests

- **`tests/open-html.test.mjs` (5 tests)** — the response-HTML builder was extracted to a pure `src/handlers/open-html.mjs` (same allowJs pattern as `open-params.mjs`) so the injection-safety invariant is now covered: a hostile vault name (`</script><script>…`, quotes, backslashes) is double-encoded (`encodeURIComponent` then `JSON.stringify`) and cannot break out of the `<script>` string, plus the redirect on/off branches and nullish-name handling. 56 total (was 51).

### Migration

- Pull, `npm install`, `npm run build` (deploys to `.template`), then `npm run deploy:all` and reload Obsidian once per running instance (or rely on Hot Reload if installed). **To get foreground-on-click on Windows:** enable the new setting per-vault AND set the Chrome `AutoLaunchProtocolsFromOrigins` policy once, then restart Chrome — see README. No change to any existing route; the setting is OFF by default so behavior is unchanged unless you opt in.

## [0.4.0] — 2026-06-10 — presence heartbeat + public `/ping` (smart-link local-mirror detection)

The bridge's half of the smart-link resolver design (see the companion vault's `smart-link-resolver.md`): one stable https link per note, resolved ON the clicking device. For that, a resolver page probes loopback ports to find a local Obsidian mirror — and needs (a) a list of candidate ports and (b) something dumb to probe. This release ships both.

### Added

- **`GET /ping` + `OPTIONS /ping` — public probe route.** Registered via `addPublicRoute()` exactly like `/open/*` (no Bearer token — a cross-origin `fetch` from the resolver page can't attach an Authorization header). `GET` returns `200 {"pong":true}`; `OPTIONS` returns `204`. Both carry `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Private-Network: true` (Chrome PNA preflight), `Access-Control-Allow-Methods: GET, OPTIONS`, and `Cache-Control: no-store` (a cached pong would fake presence). Anti-fingerprinting: the body is a bare pong — no vault name, no version. Loopback guard mirrored from `/open` (defense-in-depth; the resolver's probe always originates on the same device). Handlers live in a pure `src/handlers/ping.mjs` (same allowJs pattern as `open-params.mjs`) so the test suite exercises the contract verbatim on any Node.

  Known caveat: Local REST API mounts a global `cors()` middleware *before* extension routers, and the `cors` package short-circuits `OPTIONS` preflights (204 + `Access-Control-Allow-Origin: *`) before our handler runs — so on current Local REST API versions the explicit `OPTIONS` handler is shadowed and the preflight response lacks the PNA header. Plain CORS preflights still succeed; Chrome 138+ uses the Local Network Access permission prompt rather than PNA-header enforcement; and the resolver cascade degrades to deep-link/streaming if a probe is blocked. The handler is registered anyway: it IS the contract, and it takes over if Local REST API ever stops swallowing `OPTIONS`.

  - **Optional `?v=<vault-name>` — vault confirmation (review I1).** A blind pong is vault-agnostic: on a multi-vault device a candidate port can serve ANOTHER vault than the link's target, and the resolver would open the wrong note. `GET /ping?v=<name>` answers `200 {"pong":true}` only if the URL-decoded `<name>` strictly equals (`===`) this vault's name (`app.vault.getName()`, injected via the `makePingGetHandler(getVaultName)` factory so the handler stays pure), `404` otherwise — with the same four headers so the resolver's CORS fetch can read the status. Without `?v` the behavior is byte-for-byte unchanged; `OPTIONS` unchanged. Anti-fingerprinting preserved: the route never reveals the name, it only confirms one the requester already knows (confirmation oracle, not disclosure — the 404 body is empty).

- **Presence heartbeat (`src/presence.ts` + pure helpers in `src/presence-core.mjs`).** Writes `wiki-meta/presence/<deviceId>.json` on layout-ready and every 5 minutes (`registerInterval` → cleared on unload): `{ device, vaultName, insecurePort, lastSeen, bridgeVersion }`. LiveSync replicates the file to the server-side vault copy, where the resolver reads it to learn which devices have a live local mirror and on which port to probe (freshness TTL server-side: 10 minutes = two missed beats). The path is **deliberately visible** (not a dot-folder) — Self-hosted LiveSync does not replicate hidden paths by default, and that replication is the whole point.

  - `deviceId` = sanitized `os.hostname()` (`[a-z0-9-]`, ≤63 chars), falling back to a random 8-char id persisted in the plugin's saved data — so the same machine keeps the same presence file across restarts.
  - `insecurePort` read live from the Local REST API plugin instance (`settings.insecurePort`), with its `data.json` as fallback; if neither yields a port, the beat is skipped and logged once (retried every tick — never crashes the plugin). A one-time warning also fires if `enableInsecureServer` is off (presence is still written; the probe will just fail and the cascade falls back).
  - Failed writes (read-only vault, sync lock) are logged once and retried next tick.

- **Settings tab** (the plugin's first) with one toggle: **"Presence heartbeat (smart links)"**, default ON. Turning it back on beats immediately instead of waiting up to 5 minutes.

### Tests

- **`tests/ping.test.mjs`** (24 tests) — the four contract headers verbatim, GET/OPTIONS status + body shape, anti-fingerprinting key set, loopback guard variants, plus the `?v=` vault-confirmation matrix (match → 200, mismatch/empty/case → 404 with the four headers and an empty body, percent-encoded space + accents decoded exactly once via the raw-URL fallback, repeated-param first-value, throwing vault-name getter → 404 not a crash). **`tests/presence-core.test.mjs`** (12 tests) — device-id sanitization, fallback id charset, exact presence payload key set, visible-path invariant. 51 total with the 15 existing `open-params` tests.

### Migration

- Existing installs: pull, `npm install`, `npm run build` (deploys to `.template`), then `npm run deploy:all` and reload Obsidian once per running instance. No behavior change for existing routes. The heartbeat starts writing `wiki-meta/presence/` immediately — vaults that don't use smart links can switch the toggle off in Settings → MCP Router Bridge.
- `package-lock.json` version backfilled (it had been stuck at 0.1.1 while `package.json` advanced to 0.3.2).

## [0.3.2] — 2026-06-02 — `/open`: no flash, no tab pile-up (focus-steal + delayed close behind Obsidian)

> **Superseded by v0.5.0.** The `app.focus({steal})` + `setAlwaysOnTop` focus-steal dance described below was empirically proven NOT to work on Windows (the `SetForegroundWindow` activation policy blocks a background app). v0.5.0 removes it and foregrounds via an `obsidian://` redirect instead. The notes below are kept as the historical record.

Finishes the click-to-open comfort work across several live-test rounds on Windows. The browser tab an http click-to-open spawns can't be removed (the terminal won't dispatch `obsidian://` — and even when clickable, Claude Code mangles its `&`-separated params on Windows), so the goal became: don't let it flash, don't let it pile up, and land back in Obsidian.

### Changed

- **Obsidian is pulled to the FRONT over the browser tab.** The window-surfacing dance now uses Electron's `app.focus({ steal: true })` + a brief `setAlwaysOnTop(true→false)` toggle, and RE-raises after ~250ms (the browser re-foregrounds itself the instant it paints the response page). Plain `focus()` can't beat the Windows foreground-lock from a background process; these can. Result: after a click, Obsidian comes back in front and stays there (the browser parks behind) instead of stranding the user in the browser.
- **Delayed auto-close — invisible, no pile-up.** The `/open` tab now closes itself after ~700ms instead of immediately. By then Obsidian is in front, so the close fires BEHIND Obsidian — no visible flash — while still tidying the tab so they don't accumulate (a real memory concern over a heavy click session). The earlier immediate close flashed precisely because it fired *before* Obsidian was raised, with the browser still in front.

### Notes

- The browser PROCESS still wakes in the background on each http click (OS/terminal URL dispatch, not the plugin) — but its tabs no longer pile up. `parseOpenParams` is unchanged → its 15 tests still pass.

## [0.3.1] — 2026-06-02 — quieter `/open`: native heading flash + near-invisible auto-close tab

UX polish on the v0.3.0 click-to-open, validated live by Roland.

### Changed

- **Native scroll + heading highlight.** `?h=<heading>` navigation now opens the verified `TFile`, then scrolls via `openLinkText("#<heading>", <sourcePath>)` — a **bare-subpath** link (`#heading`, no path before the `#`) that can only resolve WITHIN the source file, so the verified-TFile guarantee from v0.3.0 holds (no cross-file re-resolution) while Obsidian applies its **native scroll + brief heading highlight**. Replaces the raw `eState.subpath` of v0.3.0, which positioned the view silently (no visual feedback — the user couldn't tell it had jumped).
- **Near-invisible auto-close tab.** The `/open` response is now a blank page that calls `window.close()` **immediately** (before the body paints) instead of a styled card shown ~100 ms then closed. The browser blip that an http click-to-open unavoidably spawns is now contentless and as brief as the browser allows. No path is echoed anymore → the reflected-XSS surface (and the `escapeHtml` helper) is removed entirely; a minimal one-line fallback shows only if the browser refuses to self-close.

### Notes

- The browser tab itself can't be eliminated for an http click-to-open (the terminal won't dispatch `obsidian://`); this only minimizes its visibility. Keeping a browser window already open further downgrades the new-window pop to a background tab. `parseOpenParams` is unchanged → its 15 tests still pass.

## [0.3.0] — 2026-06-02 — `/open` heading anchors + treeview reveal

Deep-linking for click-to-open. `GET /open/<path>` now accepts two optional query params so a clicked link can land on a specific section and surface the note in the file tree.

### Added

- **`?h=<heading>` — scroll to a heading.** The handler opens the **verified `TFile`** via `leaf.openFile(file, { eState: { subpath: "#<heading>" } })` — `eState.subpath` is the mechanism Obsidian's own link handling uses to scroll to a heading/block. It can only scroll WITHIN the file and never re-resolves *which* file opens, so the path-traversal guard + `getAbstractFileByPath` check stay the single source of truth (a code-review hardening over the initial `openLinkText("path#heading")` draft, which re-resolved the path string). Obsidian headings ARE their own anchor — nothing is inserted into the note (read-only). The heading travels as a **query param**, never as a `#fragment`: browsers never transmit the fragment to the server. Accepted with or without leading `#`(s). If the heading doesn't match, the file still opens at the top (graceful degradation).
- **`?reveal=0` — opt out of the treeview reveal.** By default `/open` now also runs the core `file-explorer:reveal-active-file` command after navigating, so the opened note is **revealed + selected** in the file-explorer tree. Best-effort (wrapped + swallowed if the File Explorer core plugin is disabled). `?reveal=0` / `false` / `no` / `off` disables it. Backward compatible: a bare `/open/<path>` behaves exactly as before, plus the reveal.
- **`parseOpenParams()`** — the query → `{ heading, reveal }` parser lives in a pure `src/handlers/open-params.mjs` (plain JS, imported by `open.ts` via the tsconfig `allowJs` setting) so the test suite runs on **every supported Node version** rather than depending on `.ts` type-stripping. Repeated params collapse to their **first** value (matching Express's array path); the heading strips **all** leading `#` (`^#+`) to match the router's `normalizeAnchor`.

### Tests

- **`tests/open-params.test.mjs`** (15 tests) + a `test` npm script (`node --test tests/*.test.mjs`) — the bridge's first test suite. Imports the pure `open-params.mjs`, so it runs on any Node (no type-stripping needed). Covers heading normalization (leading-`#`(s) strip, trim, empty→null, array-collapse, non-string), the reveal default + falsy-token set, the raw-URL fallback parse keeping the **first** repeated value, and null/undefined robustness.

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
