/**
 * Where the public click-to-open route lives, and which prefix the bridge
 * announces to its clients.
 *
 * Local REST API 5.4.0 reserves eight top-level prefixes for its own routes
 * (constants.ts BUILT_IN_ROUTE_PREFIXES: vault, active, search, commands,
 * events, mcp, open, tags) and its addPublicRoute() throws for any path whose
 * first segment is one of them. `/open/*` is therefore refused there — and
 * because 5.4.0 also ships a native, AUTHENTICATED `/open/*` (POST), a GET on
 * `/open/<path>` falls through to the Bearer check and answers 401
 * (errorCode 40101). addRoute() (authenticated) does no such check, which is
 * why /search/smart and /vault-cas/* kept working.
 *
 * So the route is registered under the plugin's own id first — the
 * namespace Local REST API itself recommends ("Start public routes with a
 * literal segment, such as your plugin's id") — and under the historical
 * `/open/*` second, for Local REST API 4.x where it still works and where
 * links built by an older router still point.
 *
 * The prefix actually registered first is announced in GET /ping's body
 * (`openPrefix`), so a client never has to guess which Local REST API version
 * a vault runs. A bridge older than 0.10.0 announces nothing; clients fall
 * back to LEGACY_OPEN_PREFIX for it.
 *
 * Plain `.mjs` so node:test imports it directly — same rationale as
 * open-params.mjs.
 */

/** Plugin-id namespace: the first segment is never reserved by Local REST API. */
export const PRIMARY_OPEN_PREFIX = '/mcp-router-bridge/open/';

/** Historical route: works on Local REST API 4.x, refused by 5.4.0. */
export const LEGACY_OPEN_PREFIX = '/open/';

/** Registration order: the first that registers is the one announced. */
export const OPEN_ROUTE_BASES = Object.freeze(['/mcp-router-bridge/open', '/open']);

/**
 * Register the GET click-to-open handler under every candidate base, in order.
 * Never throws: a refused candidate is reported, not raised, so one refusal
 * cannot stop the next candidate or the routes registered after this one.
 *
 * @param {((path: string) => { get: (handler: any) => void }) | undefined} addPublicRoute
 *   Local REST API's addPublicRoute, already bound to its public API object.
 * @param {(req: any, res: any) => unknown} handler
 * @returns {{
 *   openPrefix: string | null,
 *   registered: string[],
 *   refused: { path: string, message: string }[],
 * }} `openPrefix` is the base of the first registered route plus a trailing
 *   slash (`/mcp-router-bridge/open/`), or null when nothing registered.
 */
export function registerOpenRoutes(addPublicRoute, handler) {
  const result = { openPrefix: null, registered: [], refused: [] };
  if (typeof addPublicRoute !== 'function') return result;

  for (const base of OPEN_ROUTE_BASES) {
    const path = `${base}/*`;
    try {
      addPublicRoute(path).get(handler);
    } catch (err) {
      result.refused.push({ path, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    result.registered.push(path);
    if (result.openPrefix === null) result.openPrefix = `${base}/`;
  }
  return result;
}
