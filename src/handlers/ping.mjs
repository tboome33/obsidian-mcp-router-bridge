/**
 * GET /ping + OPTIONS /ping — the smart-link resolver's local-mirror probe.
 *
 * A resolver page (loaded from an https origin on the CLICKING device) does
 * `fetch('http://127.0.0.1:<port>/ping', {mode:'cors'})` for each candidate
 * port found in the vault's presence files. First port that answers wins →
 * the resolver redirects to this device's `/open/<path>`.
 *
 * Contract (shared with the resolver — do not change shape):
 *   GET              → 200 {"pong":true}
 *   GET ?v=<name>    → 200 {"pong":true} if the URL-decoded <name> strictly
 *                      equals this vault's name (app.vault.getName()),
 *                      otherwise 404 (same four headers — the page's CORS
 *                      fetch must be able to read the status either way)
 *   OPTIONS          → 204, no body
 *   ALL carry:  Access-Control-Allow-Origin: *
 *               Access-Control-Allow-Private-Network: true   (Chrome PNA preflight)
 *               Access-Control-Allow-Methods: GET, OPTIONS
 *               Cache-Control: no-store                      (a cached pong = stale presence)
 *
 * The `v` param exists because a multi-vault device runs one bridge per
 * vault: a candidate port from the presence files can belong to ANOTHER
 * vault than the one the link targets, and a blind pong would make the
 * resolver open the wrong note. With `?v=`, only the bridge actually
 * serving the expected vault answers 200.
 *
 * Anti-fingerprinting: the body is a bare pong — no vault name, no version,
 * no port list. A local prober learns only "a bridge listens here", which the
 * open TCP port reveals anyway. The `v` check preserves this: the route
 * never REVEALS the vault name, it only CONFIRMS a name the requester
 * already knows (confirmation oracle, not disclosure) — the 404 body is
 * empty and echoes nothing.
 *
 * Plain `.mjs` (no TypeScript) so the node:test suite imports it directly on
 * every supported Node version — same rationale as open-params.mjs.
 *
 * Registered via Local REST API's addPublicRoute() (no Bearer token): the
 * probe is a cross-origin fetch from a web page — it cannot attach an
 * Authorization header. Loopback guard mirrors /open's defense-in-depth.
 *
 * Known caveat: Local REST API mounts a global `cors()` middleware BEFORE
 * extension routers, and the cors package short-circuits OPTIONS preflights
 * (204 + Access-Control-Allow-Origin:*) before our OPTIONS handler runs. So
 * on current Local REST API versions the explicit OPTIONS handler below is
 * effectively shadowed — the preflight still succeeds for plain CORS, but
 * without Access-Control-Allow-Private-Network. Chrome 138+ replaced PNA
 * preflight enforcement with the Local Network Access permission prompt, so
 * the cascade still degrades correctly (worst case: fallback to deep link /
 * streaming). We register the handler anyway: it is the contract, and it
 * takes over if Local REST API ever stops swallowing OPTIONS.
 */

export const PING_HEADERS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
});

/**
 * True when the request comes from loopback (or req.ip is unset, matching
 * the /open handler's tolerance for odd Express configs).
 * @param {{ ip?: unknown } | null | undefined} req
 * @returns {boolean}
 */
export function isLoopbackRequest(req) {
  const rawIp = String((req && req.ip) || '');
  const ip = rawIp.replace(/^::ffff:/, '');
  return !ip || ip === '127.0.0.1' || ip === '::1';
}

/** @param {any} res */
function setPingHeaders(res) {
  for (const [name, value] of Object.entries(PING_HEADERS)) {
    res.set(name, value);
  }
}

/**
 * Extract the optional `v` (vault-name confirmation) query param.
 *
 * Same two-path convention as parseOpenParams (open-params.mjs): prefer
 * Express's `req.query` when populated, fall back to parsing the raw URL.
 * URL-decoding happens exactly ONCE in both paths — Express's query parser
 * and URLSearchParams both percent-decode — so a vault name containing `%`
 * is never double-decoded. Repeated params collapse to their FIRST value,
 * matching the open-params convention.
 *
 * @param {{ query?: Record<string, unknown>, originalUrl?: string, url?: string } | null | undefined} req
 * @returns {string | null | undefined} `undefined` when the param is absent;
 *   the decoded string when present; `null` when present but unusable
 *   (non-string garbage from exotic query parsing — treated as a mismatch).
 */
export function extractVaultParam(req) {
  let q = req && req.query && typeof req.query === 'object' ? req.query : {};

  if (!q || Object.keys(q).length === 0) {
    const url = String((req && (req.originalUrl || req.url)) || '');
    const qIdx = url.indexOf('?');
    if (qIdx !== -1) {
      // Keep the FIRST occurrence of each key (same rationale as
      // open-params.mjs — Object.fromEntries would keep the LAST).
      q = {};
      for (const [k, v] of new URLSearchParams(url.slice(qIdx + 1))) {
        if (!(k in q)) q[k] = v;
      }
    }
  }

  if (!('v' in q)) return undefined;
  const raw = Array.isArray(q.v) ? q.v[0] : q.v;
  return typeof raw === 'string' ? raw : null;
}

/**
 * Factory for the GET /ping handler — the vault name is injected so the
 * handler stays pure/testable (same pattern as makeOpenHandler in main.ts,
 * which receives `app`). `getVaultName` is read lazily at request time
 * (vault renames, late init).
 *
 *   GET /ping            → 200 {"pong":true}
 *   GET /ping?v=<name>   → 200 if <name> (URL-decoded) === getVaultName(),
 *                          else 404 with the same four headers, empty body
 *
 * @param {() => string} getVaultName
 * @returns {(req: any, res: any) => void}
 */
export function makePingGetHandler(getVaultName) {
  return function handlePingGet(req, res) {
    if (!isLoopbackRequest(req)) {
      res.status(403).type('text/plain').send('loopback only');
      return;
    }
    setPingHeaders(res);

    const requested = extractVaultParam(req);
    if (requested !== undefined) {
      let current;
      try {
        current = typeof getVaultName === 'function' ? getVaultName() : undefined;
      } catch {
        current = undefined; // can't determine the vault → can't confirm → 404
      }
      // Strict comparison (===) on the URL-decoded value. `requested` may be
      // null (unusable param) — also a mismatch. The 404 carries the same
      // four headers so the resolver's CORS fetch can read the status, and
      // an EMPTY body (never echo or reveal the actual name).
      if (typeof current !== 'string' || requested !== current) {
        res.status(404).end();
        return;
      }
    }

    res.status(200).json({ pong: true });
  };
}

/**
 * OPTIONS /ping → 204 (preflight; PNA header is the payload here)
 * @param {any} req @param {any} res
 */
export function handlePingOptions(req, res) {
  if (!isLoopbackRequest(req)) {
    res.status(403).type('text/plain').send('loopback only');
    return;
  }
  setPingHeaders(res);
  res.status(204).end();
}
