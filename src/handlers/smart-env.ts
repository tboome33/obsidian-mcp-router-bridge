import type { App } from 'obsidian';
import { collectSmartEnvSources, SMART_ENV_STORE_DIR } from './smart-env-core.mjs';

/**
 * GET /smart-env/sources
 *
 * Serves the whole-note records of Smart Connections' vector store as NDJSON so
 * a router without this machine's disk can run `find_twin_pages` here. The
 * contract, the losslessness argument and the "never 404" rule all live in
 * src/handlers/smart-env-core.mjs — this file is only the Obsidian wiring.
 *
 * Auth: registered via addRoute (NOT addPublicRoute), so Local REST API's
 * Bearer check applies. This returns vault-derived data and must sit behind the
 * same key as reading the notes themselves — unlike /open and /ping, which are
 * public because a browser navigation cannot carry an Authorization header.
 *
 * THE ROUTE TAKES NO PATH INPUT. The store directory is a module constant, so
 * there is no parameter to traverse out of and no guard to get wrong: the only
 * dot-directory this bridge will ever read is the one named in the core. That
 * matters more than usual here, because a general "read a dot-file" route would
 * hand out `.obsidian/plugins/obsidian-local-rest-api/data.json` — the Bearer
 * key itself.
 *
 * Compression is negotiated, not assumed: the body is gzipped only when the
 * client said it accepts it. It is worth the round trip — measured on this
 * vault, 22.3 MB of filtered records compress to 4.31 MB — and the router's
 * HTTP client (undici) advertises gzip and inflates it transparently, so the
 * consumer needs no code for this at all. gzip runs ASYNC: the synchronous call
 * costs ~300 ms on that payload, and this is Obsidian's UI thread.
 */
export function makeSmartEnvSourcesHandler(app: App) {
  return async function handleSmartEnvSources(req: any, res: any): Promise<void> {
    try {
      const adapter = (app.vault as any).adapter;
      const { header, body } = await collectSmartEnvSources({
        list: (dir: string) => adapter.list(dir),
        read: (p: string) => adapter.read(p),
      });

      res.set('Content-Type', 'application/x-ndjson; charset=utf-8');
      // The store is rewritten whenever Smart Connections reindexes; a cached
      // copy would silently answer for a vault that has moved on.
      res.set('Cache-Control', 'no-store');
      // Counts are echoed in headers as well as in the body's first line so a
      // caller can see the shape of the answer without reading the payload.
      res.set('X-Smart-Env-Available', String(header.available === true));
      if (header.available === true) {
        res.set('X-Smart-Env-Files', String(header.files));
        res.set('X-Smart-Env-Truncated', String(header.truncated === true));
      }

      const raw = Buffer.from(body, 'utf8');
      const accepts = String(req?.headers?.['accept-encoding'] || '').toLowerCase();
      if (!accepts.includes('gzip')) {
        res.status(200).end(raw);
        return;
      }

      const zlib = require('zlib');
      zlib.gzip(raw, (err: unknown, gz: Buffer) => {
        if (err) {
          // Compression is an optimisation; losing it must not lose the answer.
          res.status(200).end(raw);
          return;
        }
        res.set('Content-Encoding', 'gzip');
        res.set('Vary', 'Accept-Encoding');
        res.status(200).end(gz);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] /smart-env/sources failed:', err);
      // NOT 404 — that status is reserved for "this bridge has no such route".
      res.status(500).json({
        error: 'Failed to read the Smart Connections store',
        kind: 'smart_env_error',
        storePath: SMART_ENV_STORE_DIR,
      });
    }
  };
}
