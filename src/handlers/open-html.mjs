/**
 * Build the tiny HTML status page returned by GET /open/<path>.
 *
 * Pure + exported so the injection-safety invariant is unit-testable (the
 * handler in open.ts has no other coverage). The vault name is embedded ONLY
 * inside an `obsidian://` URI via `encodeURIComponent`, and THEN the whole URI
 * is emitted as a JS string literal via `JSON.stringify`. Double-encoded:
 * encodeURIComponent already turns `<`, `>`, `"`, `'`, `\`, space, etc. into
 * `%XX`, so nothing a hostile vault name could contain can break out of the
 * `<script>` string or inject HTML/markup. DO NOT interpolate `vaultName` into
 * the page by any other path.
 *
 * @param {string} vaultName    Obsidian vault name (app.vault.getName()).
 * @param {boolean} foreground  When true, the page redirects to
 *   `obsidian://open?vault=<name>` so the OS protocol handler foregrounds
 *   Obsidian (no in-renderer focus call can — Windows foreground lock). When
 *   false, no redirect is emitted (default — avoids Chrome's per-click
 *   "Open Obsidian?" dialog for users without the AutoLaunchProtocolsFromOrigins
 *   policy).
 * @returns {string} The complete HTML document.
 */
export function buildOpenedHtml(vaultName, foreground) {
  const obsUri = 'obsidian://open?vault=' + encodeURIComponent(vaultName ?? '');
  const redirectScript = foreground ? 'location.href=' + JSON.stringify(obsUri) + ';' : '';
  // window.close() only works for script-opened popups, not regular tab
  // navigations — best-effort tidy-up so click-opened tabs don't accumulate.
  return (
    '<!doctype html><meta charset="utf-8"><title>Opened in Obsidian</title>' +
    '<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;' +
    'justify-content:center;font-family:system-ui,-apple-system,sans-serif;' +
    'color:#666;background:#fafafa;font-size:.95rem}</style>' +
    '<body>Opened in Obsidian.' +
    '<script>' + redirectScript +
    'setTimeout(function(){try{window.close()}catch(e){}},700);</script></body>'
  );
}
