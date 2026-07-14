import type { App, TFile } from 'obsidian';
import { parseOpenParams } from './open-params.mjs';
import { buildOpenedHtml } from './open-html.mjs';
import { resolveOpenTarget } from './open-resolve.mjs';

/**
 * GET /open/<vault-relative-path>[?h=<heading>][&reveal=0]
 *
 * Navigates Obsidian to the specified file in the active pane, then returns a
 * tiny HTML status page. Bringing Obsidian to the OS foreground from the
 * renderer is impossible while the browser owns focus (Windows foreground
 * lock — see the long comment by the response below); the page therefore
 * flashes the taskbar (always) and, when the `foregroundViaProtocol` opt-in is
 * on, hands off to `obsidian://open?vault=<name>` so the OS shell does the
 * activation.
 *
 * Optional query params (v0.3.0):
 *   - `h=<heading>` — scroll to a heading inside the note (the heading's
 *     TEXT, e.g. `?h=Installation`). Obsidian headings ARE their own anchor
 *     (no marker to insert). MUST be a query param, not a `#fragment` —
 *     browsers never transmit the fragment to the server.
 *   - `reveal=0` — suppress revealing the file in the file-explorer
 *     treeview. Default is ON (reveal + select the opened note).
 *
 * Purpose: make wiki pages clickable from Claude Code chat (or any client
 * that emits clickable http(s) links). The `obsidian://` URI scheme is
 * blocked by many CLI terminals' URL dispatchers (Claude Code included —
 * only http(s) is allowed for security). This route gives those clients
 * an http(s) URL they CAN dispatch, which then triggers Obsidian to open
 * the file via the in-process workspace API (no obsidian:// roundtrip).
 *
 * Security:
 *   - Loopback-only (Local REST API binds 127.0.0.1; we double-check req.ip).
 *   - Path traversal refused (`..` segments, absolute paths, drive letters).
 *   - File must RESOLVE in the vault — either the exact path, or (if that
 *     misses) a UNIQUE basename match found by enumerating the vault (never
 *     escapes it). 404 when nothing matches; 409 when the basename is ambiguous
 *     (refuses to guess). See open-resolve.mjs for the security rationale.
 *   - No auth — justified because the scope is navigation-only (no read of
 *     content, no write, no execution), the binding is loopback (other
 *     local processes can already read the vault directly), and embedding
 *     a Bearer token into a clickable URL would be both insecure (token
 *     in browser history / clipboard) and impractical (the browser can't
 *     attach a custom Authorization header to a click navigation).
 */
export function makeOpenHandler(app: App, foregroundViaProtocol?: () => boolean) {
  // At most one pending flashFrame-cleanup listener across rapid clicks (the
  // window is a singleton via getCurrentWindow); reset when it fires.
  let flashCleanupPending = false;
  return async function handleOpen(req: any, res: any): Promise<void> {
    try {
      // Defense in depth: refuse anything that's clearly not loopback.
      // Local REST API binds to 127.0.0.1 by default but we check anyway —
      // some users may have configured it to bind 0.0.0.0 for LAN access.
      // We strip the IPv4-mapped IPv6 prefix (::ffff:) that some Node
      // versions wrap incoming IPv4 connections in.
      const rawIp = String(req.ip || '');
      const ip = rawIp.replace(/^::ffff:/, '');
      if (ip && ip !== '127.0.0.1' && ip !== '::1') {
        res.status(403).type('text/plain').send('loopback only');
        return;
      }

      // Extract the vault-relative path. We register the route as
      // '/open/*', so Express puts the matched part in req.params[0]
      // (Express 4) — already URL-decoded. We fall back to parsing
      // req.path or req.url directly if for some reason that's not set
      // (different Express versions or registration patterns).
      let rawPath = '';
      if (req.params && typeof req.params[0] === 'string') {
        rawPath = req.params[0];
      } else {
        const fullPath: string = String(req.path || req.url || '');
        const prefix = '/open/';
        const idx = fullPath.indexOf(prefix);
        if (idx === -1) {
          res.status(400).type('text/plain').send('missing path');
          return;
        }
        let tail = fullPath.substring(idx + prefix.length);
        // Strip any query string
        const qsIdx = tail.indexOf('?');
        if (qsIdx !== -1) tail = tail.substring(0, qsIdx);
        try {
          rawPath = decodeURIComponent(tail);
        } catch {
          res.status(400).type('text/plain').send('malformed URL encoding');
          return;
        }
      }

      // Normalize separators (Windows users might paste a backslashed path)
      // and collapse runs of slashes. Obsidian vault paths use POSIX (/).
      const normalized = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');

      // Path traversal guards. Reject absolute paths, leading slash,
      // any `..` segment, Windows drive letters. Be strict — a false
      // positive just refuses one click, a false negative could let a
      // local process navigate Obsidian to /etc/passwd via the vault
      // adapter's escape behaviour.
      if (
        normalized.length === 0 ||
        normalized.startsWith('/') ||
        normalized.startsWith('..') ||
        /(^|\/)\.\.(\/|$)/.test(normalized) ||
        /^[A-Za-z]:/.test(normalized)
      ) {
        res.status(403).type('text/plain').send('path traversal refused');
        return;
      }

      // Resolve which vault object opens. Exact path first (TFile/TFolder);
      // if that misses, fall back to BASENAME resolution (like Obsidian
      // resolves a [[wikilink]]) so a correct filename in the WRONG folder
      // still opens the right note instead of 404 — the click-to-open URL
      // self-heals. Returns a VERIFIED vault reference or null. Details +
      // security rationale in open-resolve.mjs.
      const resolved = resolveOpenTarget(app, normalized);
      if (resolved.status === 'ambiguous') {
        // Correct basename but it exists in MULTIPLE folders — refuse to guess
        // (opening an arbitrary one could surface the wrong note). 409 + the
        // candidates so the caller re-requests with the exact full path.
        res
          .status(409)
          .type('text/plain')
          .send('ambiguous basename in vault — multiple matches:\n' + resolved.candidates.join('\n'));
        return;
      }
      if (resolved.status !== 'exact' && resolved.status !== 'corrected') {
        res.status(404).type('text/plain').send('file not found in vault: ' + normalized);
        return;
      }
      const file = resolved.file;

      // Optional navigation params from the query string (v0.3.0):
      //   ?h=<heading>   scroll to a heading anchor inside the note
      //   ?reveal=0      suppress revealing the file in the treeview
      // The heading travels as a QUERY param, never as a `#fragment` —
      // browsers never send the fragment to the server, so `#…` would be
      // invisible here. See parseOpenParams().
      const { heading, reveal } = parseOpenParams(req);

      // Open in the active pane. Files open by their VERIFIED TFile reference
      // (rationale in the block comment below); folders fall back to
      // openLinkText, which handles the "show folder" case gracefully.
      const isTFile = typeof (file as any).extension === 'string';
      if (isTFile) {
        // Open the VERIFIED TFile reference — never re-resolved — so the
        // traversal guard + getAbstractFileByPath check above stay the single
        // source of truth for WHICH file opens.
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file as TFile);
        if (heading) {
          // Scroll to the heading via a BARE-subpath link ('#heading', with NO
          // path before the '#'). A subpath-only linktext can only resolve
          // WITHIN the source file — it can never point at a different file —
          // so the verified-TFile guarantee above holds. Unlike a raw
          // `eState.subpath` (which positions silently), openLinkText applies
          // Obsidian's NATIVE scroll + heading highlight — the visual feedback
          // you get clicking a `[[note#heading]]` link. sourcePath = the RESOLVED
          // file's own path (not `normalized`, which may have been a wrong-folder
          // path corrected by basename fallback). If the heading doesn't exist,
          // the file stays at the top — graceful degradation, never a failure.
          await app.workspace.openLinkText('#' + heading, (file as TFile).path, false);
        }
      } else {
        await app.workspace.openLinkText((file as { path: string }).path, '', false);
      }

      // Reveal the just-opened file in the file-explorer treeview (visible +
      // selected), unless explicitly disabled with ?reveal=0. The core
      // "file-explorer:reveal-active-file" command acts on the ACTIVE file —
      // which we just opened above. Best-effort: the command only exists if
      // the core File Explorer plugin is enabled; wrapped + swallowed so a
      // missing command never breaks navigation. The default is ON because
      // the whole point of an /open click is to surface the note.
      if (reveal) {
        try {
          (app as any).commands?.executeCommandById?.('file-explorer:reveal-active-file');
        } catch {
          /* ignore — reveal is a nicety, not a requirement */
        }
      }

      // Bring Obsidian to the front. INVESTIGATED 2026-06-18 (see the
      // project-bridge "Focus-steal" note): NO in-renderer Electron call can
      // steal the OS foreground from the browser that just received the click —
      // it's the Windows SetForegroundWindow activation policy, not an Electron
      // gap. `app.focus({steal:true})` is "give focus, never take it" by design
      // (electron PR#10783); setAlwaysOnTop levels / moveTop / minimize+restore
      // only reorder z-order; ALL were empirically confirmed to fail against a
      // freshly-clicked Chrome. The only non-native way to actually foreground
      // is to let the OS protocol handler do it via an `obsidian://` URI — the
      // opt-in `foregroundViaProtocol` path in the HTML response below.
      //
      // Best-effort, ALWAYS: flashFrame(true) — the Windows-sanctioned signal
      // for "this window wants attention but can't take focus" (the taskbar
      // icon blinks; auto-cleared once Obsidian regains focus). Pure Electron,
      // no native code, harmless and a no-op cross-platform when unsupported.
      try {
        const win: any = (app as any).workspace?.containerEl?.ownerDocument?.defaultView;
        const electronRemote: any =
          win?.require?.('@electron/remote') || win?.require?.('electron')?.remote;
        const browserWindow: any = electronRemote?.getCurrentWindow?.();
        const electronApp: any = electronRemote?.app;
        // Best-effort focus. On macOS/Linux app.focus({steal})/show()/focus()
        // DO foreground the window; on Windows they're harmless no-ops against a
        // foreground browser (that's the lock — hence the obsidian:// opt-in in
        // the response below). This is NOT the old alwaysOnTop dance (removed —
        // it only reordered z-order, never activated, and on release dropped the
        // window BEHIND others when multiple vaults were open).
        try { electronApp?.focus?.({ steal: true }); } catch { /* ignore */ }
        try { browserWindow?.show?.(); } catch { /* ignore */ }
        try { browserWindow?.focus?.(); } catch { /* ignore */ }
        if (browserWindow) {
          // flashFrame: the Windows-sanctioned "needs attention" signal when the
          // foreground can't be taken (taskbar icon blinks until activation).
          // Guard the cleanup listener so rapid clicks don't stack listeners.
          try { browserWindow.flashFrame(true); } catch { /* ignore */ }
          if (!flashCleanupPending) {
            flashCleanupPending = true;
            try {
              browserWindow.once?.('focus', () => {
                flashCleanupPending = false;
                try { browserWindow.flashFrame(false); } catch { /* ignore */ }
              });
            } catch { flashCleanupPending = false; }
          }
        }
      } catch { /* ignore */ }

      // Response page. When `foregroundViaProtocol` is enabled (plugin setting,
      // default OFF), the page redirects to a vault-only
      // `obsidian://open?vault=<name>` (NO file => it only FOCUSES the
      // already-navigated window, never re-navigates). The OS shell — not this
      // background renderer — performs the activation, so it bypasses Windows'
      // foreground lock entirely. OFF by default because, without a one-time
      // Chrome `AutoLaunchProtocolsFromOrigins` policy pre-allowing obsidian://
      // from http://127.0.0.1, Chrome shows an "Open Obsidian?" dialog on EVERY
      // click (the per-site "always allow" checkbox was removed in Chrome 77);
      // WITH the policy the redirect fires silently — zero extra clicks. See
      // the README "Bring Obsidian to the front" section for the one-time setup.
      //
      // window.close() only works for script-opened popups, not regular tab
      // navigations — so it's best-effort tidy-up. No request input is echoed
      // into the page => no reflected-XSS surface.
      const wantProtocolForeground =
        typeof foregroundViaProtocol === 'function' ? !!foregroundViaProtocol() : false;
      const vaultName = (app.vault as any)?.getName?.() ?? '';
      const html = buildOpenedHtml(vaultName, wantProtocolForeground);

      res
        .status(200)
        .type('text/html; charset=utf-8')
        .send(html);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] /open failed:', err);
      res
        .status(500)
        .type('text/plain')
        .send('internal error: ' + ((err as Error).message || String(err)));
    }
  };
}
