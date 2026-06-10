/**
 * GET /ping + OPTIONS /ping — the smart-link resolver's local-mirror probe.
 *
 * A resolver page (loaded from an https origin on the CLICKING device) does
 * `fetch('http://127.0.0.1:<port>/ping', {mode:'cors'})` for each candidate
 * port found in the vault's presence files. First port that answers wins →
 * the resolver redirects to this device's `/open/<path>`.
 *
 * Contract (shared with the resolver — do not change shape):
 *   GET     → 200 {"pong":true}
 *   OPTIONS → 204, no body
 *   BOTH carry: Access-Control-Allow-Origin: *
 *               Access-Control-Allow-Private-Network: true   (Chrome PNA preflight)
 *               Access-Control-Allow-Methods: GET, OPTIONS
 *               Cache-Control: no-store                      (a cached pong = stale presence)
 *
 * Anti-fingerprinting: the body is a bare pong — no vault name, no version,
 * no port list. A local prober learns only "a bridge listens here", which the
 * open TCP port reveals anyway.
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
 * GET /ping → 200 {"pong":true}
 * @param {any} req @param {any} res
 */
export function handlePingGet(req, res) {
  if (!isLoopbackRequest(req)) {
    res.status(403).type('text/plain').send('loopback only');
    return;
  }
  setPingHeaders(res);
  res.status(200).json({ pong: true });
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
