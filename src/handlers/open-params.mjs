/**
 * Pure query-string parser for the `GET /open` handler's navigation params.
 *
 * Extracted to a plain `.mjs` (no TypeScript) on purpose: the test suite
 * imports it directly, and importing the `.ts` handler would only work on
 * Node >= 23.6 (built-in type stripping) — which made `npm test` fail on the
 * Node 20 baseline this package targets (codex review 2026-06-02, P2). As a
 * plain ES module it runs on every supported Node. `open.ts` imports it via
 * the tsconfig `allowJs` setting; esbuild bundles it normally.
 *
 *   - `h`      → heading text to scroll to. Accepted with or without leading
 *                `#`(s) — stripped to match the router's `normalizeAnchor`
 *                (`^#+`). Empty / whitespace-only → null.
 *   - `reveal` → reveal the file in the file-explorer tree. Default TRUE;
 *                only the explicit falsy tokens `0` / `false` / `no` / `off`
 *                (case-insensitive) turn it off.
 *
 * Express 4 populates `req.query`. Fallback: parse the query off
 * `req.originalUrl` / `req.url`. Repeated params collapse to their FIRST
 * value in BOTH paths (Express arrays → `[0]`; the URL fallback keeps the
 * first occurrence — codex review 2026-06-02, P3; `Object.fromEntries` would
 * have kept the last).
 *
 * @param {{ query?: Record<string, unknown>, originalUrl?: string, url?: string } | null | undefined} req
 * @returns {{ heading: string | null, reveal: boolean }}
 */
export function parseOpenParams(req) {
  let q = req && req.query && typeof req.query === 'object' ? req.query : {};

  if (!q || Object.keys(q).length === 0) {
    const url = String((req && (req.originalUrl || req.url)) || '');
    const qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      // Keep the FIRST occurrence of each key, to match the req.query path
      // (which takes [0] of any repeated-param array). Object.fromEntries on
      // URLSearchParams.entries() would keep the LAST — the P3 bug.
      q = {};
      for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1))) {
        if (!(k in q)) q[k] = v;
      }
    }
  }

  const first = (v) => (Array.isArray(v) ? v[0] : v);

  let heading = null;
  const rawH = first(q.h);
  if (typeof rawH === 'string') {
    const trimmed = rawH.trim().replace(/^#+/, '').trim();
    if (trimmed.length > 0) heading = trimmed;
  }

  const rawR = first(q.reveal);
  const reveal = !(typeof rawR === 'string' && /^(0|false|no|off)$/i.test(rawR.trim()));

  return { heading, reveal };
}
