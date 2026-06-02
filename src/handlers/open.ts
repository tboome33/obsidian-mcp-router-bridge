import type { App, TFile } from 'obsidian';
import { parseOpenParams } from './open-params.mjs';

/**
 * GET /open/<vault-relative-path>[?h=<heading>][&reveal=0]
 *
 * Navigates Obsidian to the specified file in the active pane. Returns a
 * tiny HTML page that auto-closes after a short DELAY (~700ms). The focus
 * dance below raises Obsidian to the front first (and it stays there), so
 * the delayed close fires BEHIND Obsidian — invisible (no flash) — while
 * still tidying the tab so they don't accumulate. An immediate close (the
 * earlier behavior) flashed because it fired before Obsidian was raised,
 * with the browser still in front.
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
 *   - File must exist in the vault (404 otherwise).
 *   - No auth — justified because the scope is navigation-only (no read of
 *     content, no write, no execution), the binding is loopback (other
 *     local processes can already read the vault directly), and embedding
 *     a Bearer token into a clickable URL would be both insecure (token
 *     in browser history / clipboard) and impractical (the browser can't
 *     attach a custom Authorization header to a click navigation).
 */
export function makeOpenHandler(app: App) {
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

      // Verify the file exists in the vault. getAbstractFileByPath returns
      // TFile, TFolder, or null. We accept both files and folders — opening
      // a folder navigates to its index (or shows the folder if there's no
      // index) which is the natural extension.
      const file = app.vault.getAbstractFileByPath(normalized);
      if (!file) {
        res.status(404).type('text/plain').send('file not found in vault: ' + normalized);
        return;
      }

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
          // you get clicking a `[[note#heading]]` link. sourcePath = the path
          // we just opened. If the heading doesn't exist, the file stays at the
          // top — graceful degradation, never a failure.
          await app.workspace.openLinkText('#' + heading, normalized, false);
        }
      } else {
        await app.workspace.openLinkText(normalized, '', false);
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

      // Bring Obsidian to the FRONT, over the browser tab the click-to-open
      // just spawned. Clicking an http link foregrounds the browser; we no
      // longer auto-close the tab (that caused a black flash), so instead we
      // pull Obsidian back in front and let the tab park behind it. Windows
      // blocks a background app from stealing the foreground via plain
      // focus(), so we use the documented escape hatches:
      // `app.focus({ steal: true })` (Electron's explicit OS-foreground steal)
      // + a brief `setAlwaysOnTop` toggle (nudges the window to the top of the
      // z-order). We also RE-RAISE after a short delay, because the browser
      // re-foregrounds itself the instant it paints the response page — the
      // delayed raise wins that race. All best-effort + swallowed; worst case
      // the note is still open and the user Alt-Tabs to it.
      try {
        const win: any = (app as any).workspace?.containerEl?.ownerDocument?.defaultView;
        const electronRemote =
          win?.require?.('@electron/remote') || win?.require?.('electron')?.remote;
        const browserWindow = electronRemote?.getCurrentWindow?.();
        const electronApp = electronRemote?.app;

        const raise = () => {
          try { if (typeof win?.focus === 'function') win.focus(); } catch { /* ignore */ }
          try { browserWindow?.show?.(); } catch { /* ignore */ }
          try { browserWindow?.focus?.(); } catch { /* ignore */ }
          try { browserWindow?.moveTop?.(); } catch { /* ignore */ }
          // setAlwaysOnTop(true) then (false): forces the window above others
          // in z-order even from the background — a reliable Windows trick.
          try { browserWindow?.setAlwaysOnTop?.(true); } catch { /* ignore */ }
          try { browserWindow?.setAlwaysOnTop?.(false); } catch { /* ignore */ }
          // Electron's explicit "steal the OS foreground" API (Win/macOS).
          try { electronApp?.focus?.({ steal: true }); } catch { /* ignore */ }
        };

        raise();
        // Re-raise after the browser has rendered its tab (and grabbed focus).
        // Fires in the Obsidian process AFTER this response is sent.
        try { setTimeout(raise, 250); } catch { /* ignore */ }
      } catch {
        /* ignore */
      }

      // Tiny auto-closing HTML response. The window.close() works only on
      // browser windows opened via JS (popup-style) — not on regular
      // tab navigations. So the close attempt is best-effort; the page
      // itself remains a friendly status message.
      // Light page that auto-closes after a short DELAY. The delay is the
      // whole trick: the focus dance above raises Obsidian to the FRONT within
      // ~250ms (confirmed) and Obsidian STAYS front (the browser parks behind),
      // so when this tab closes ~700ms later the close happens BEHIND Obsidian
      // — invisible, no flash — while still cleaning the tab up so tabs don't
      // accumulate (a real memory concern over a heavy click session). The
      // earlier 0-100ms close flashed precisely because it fired BEFORE
      // Obsidian was raised, with the browser still in front. No user input is
      // echoed → no reflected-XSS surface.
      const html =
        '<!doctype html><meta charset="utf-8"><title>Opened in Obsidian</title>' +
        '<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;' +
        'justify-content:center;font-family:system-ui,-apple-system,sans-serif;' +
        'color:#666;background:#fafafa;font-size:.95rem}</style>' +
        '<body>Opened in Obsidian.' +
        '<script>setTimeout(function(){try{window.close()}catch(e){}},700);</script></body>';

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
