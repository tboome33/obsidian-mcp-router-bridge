import type { App, TFile } from 'obsidian';

/**
 * GET /open/<vault-relative-path>
 *
 * Navigates Obsidian to the specified file in the active pane. Returns a
 * tiny HTML page that auto-closes on Chrome/Edge when opened as a new
 * tab/popup (best-effort — depends on the browser's window.close policy).
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

      // Open in the active pane. We prefer leaf.openFile(TFile) over
      // workspace.openLinkText(text, '', false) — openFile is the direct
      // navigation API (the same one most plugins use for "open this file"
      // commands), while openLinkText goes through wikilink resolution which
      // can no-op silently if the link target is interpreted as ambiguous.
      // Folders fall back to openLinkText which handles the "show folder"
      // case gracefully.
      const isTFile = typeof (file as any).extension === 'string';
      if (isTFile) {
        const leaf = app.workspace.getLeaf(false);
        await leaf.openFile(file as TFile);
      } else {
        await app.workspace.openLinkText(normalized, '', false);
      }

      // Best-effort window surfacing. Obsidian is Electron-based — we try
      // multiple paths because the API surface for "bring window to front"
      // changed across Electron versions and Obsidian doesn't expose a
      // first-party helper for it. All attempts are wrapped in try/catch
      // and swallowed; if none of them work, the file is still open in
      // Obsidian and the user just needs to Alt+Tab to it.
      try {
        const win: any = (app as any).workspace?.containerEl?.ownerDocument?.defaultView;
        if (win) {
          // 1. Plain window.focus() — works in some browsers, no-op for
          //    Electron BrowserWindows in the background.
          if (typeof win.focus === 'function') {
            try { win.focus(); } catch { /* ignore */ }
          }

          // 2. Electron remote (older Electron API path, still present in
          //    Obsidian's Electron version as of this writing).
          try {
            const electronRemote = win.require?.('@electron/remote');
            const browserWindow = electronRemote?.getCurrentWindow?.();
            if (browserWindow) {
              try { browserWindow.show?.(); } catch { /* ignore */ }
              try { browserWindow.focus?.(); } catch { /* ignore */ }
              try { browserWindow.moveTop?.(); } catch { /* ignore */ }
            }
          } catch { /* ignore */ }

          // 3. Legacy electron.remote (deprecated but sometimes still works).
          try {
            const legacyRemote = win.require?.('electron')?.remote;
            const legacyWindow = legacyRemote?.getCurrentWindow?.();
            if (legacyWindow) {
              try { legacyWindow.show?.(); } catch { /* ignore */ }
              try { legacyWindow.focus?.(); } catch { /* ignore */ }
            }
          } catch { /* ignore */ }
        }
      } catch {
        /* ignore */
      }

      // Tiny auto-closing HTML response. The window.close() works only on
      // browser windows opened via JS (popup-style) — not on regular
      // tab navigations. So the close attempt is best-effort; the page
      // itself remains a friendly status message.
      const safePath = escapeHtml(normalized);
      const html =
        '<!doctype html><meta charset="utf-8"><title>Opened in Obsidian</title>' +
        '<style>body{font-family:system-ui,-apple-system,sans-serif;padding:2em;color:#444;text-align:center;background:#fafafa}' +
        'code{background:#eee;padding:2px 6px;border-radius:3px}' +
        '.muted{font-size:0.85em;color:#888;margin-top:1em}</style>' +
        '<p>Opened <code>' + safePath + '</code> in Obsidian.</p>' +
        '<p class="muted">You can close this tab.</p>' +
        '<script>setTimeout(function(){try{window.close()}catch(e){}}, 100);</script>';

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

/**
 * Minimal HTML-entity escape for echoing the requested path back into the
 * response body. Defends against the (low-impact) reflected-XSS pathway
 * where a malicious URL like /open/<script>alert(1)</script> would inject
 * markup into the response page.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
