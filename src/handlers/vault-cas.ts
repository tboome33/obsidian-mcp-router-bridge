import type { App } from 'obsidian';
import { normalizeVaultPath, performCasWrite } from './vault-cas-core.mjs';

/**
 * PUT /vault-cas/<vault-relative-path>
 *
 * Atomic compare-and-swap write (C1 — optimistic concurrency). The companion
 * obsidian-mcp-router uses this to refuse a write when the target changed since
 * the caller read it — the fix for two parallel sessions silently clobbering
 * each other's edits.
 *
 * Contract
 *   Headers:
 *     If-Match-Content-Sha256: <64-hex>   (required) — the content hash the
 *         caller based its edit on, from get_file's `contentSha256`.
 *     Content-Type: text/plain            — the new full file content travels
 *         as the raw body. We use text/plain (not text/markdown) deliberately:
 *         Local REST API's text body-parser yields a string for text/* content
 *         types. The MIME type on the wire does not change the bytes written to
 *         disk.
 *   Body: the full new file content (empty string writes an empty file).
 *
 * Responses
 *   200 { ok:true, path, bytesWritten, contentSha256 }      — write applied
 *   400 { error, kind:'cas_bad_request', reason }           — bad path/encoding/body/precondition
 *   409 { error, kind:'cas_conflict', reason, expectedSha, currentSha }
 *          reason 'content-changed' — file exists but its hash differs
 *          reason 'target-missing'  — precondition expects content, file is gone
 *   403 { error, kind:'cas_bad_request', reason:'traversal' }
 *   500 { error, kind:'cas_error' }
 *
 * A client that gets a raw 404 here is talking to a Local REST API without this
 * bridge route (older bridge, or bridge disabled) — this handler NEVER returns
 * 404. The router treats a 404 (route absent) OR any 400/413/415 (route present
 * but cannot service this request shape) as "atomic tier unusable → fall back"
 * to its own GET-compare-then-PUT; only a genuine 409 conflict (and auth /
 * network / 5xx) is a hard error. Distinguishing 404 from 409 is what lets the
 * atomic tier degrade cleanly.
 *
 * Atomicity — HONEST SCOPE. The read→decide→write critical section runs inside
 * withCasLock (a module-level mutex, in vault-cas-core.mjs). Because Obsidian's
 * vault runs on a single JS event loop, this makes the section indivisible
 * against OTHER /vault-cas writes. It is NOT indivisible against a writer that
 * does NOT go through this route: a plain core PUT /vault (the router's own
 * non-ifMatch write path — the DEFAULT), a save from the open Obsidian editor,
 * or an Obsidian Sync / LiveSync apply can still land between our read and our
 * write. C1 prevents CAS-vs-CAS clobbering; full clobber-prevention requires
 * every writer to use ifMatch. This is inherent to optimistic concurrency.
 *
 * Auth: registered via addRoute (NOT addPublicRoute), so Local REST API's
 * Bearer-token check applies — same trust surface as the core PUT /vault it
 * guards.
 */
export function makeVaultCasHandler(app: App) {
  return async function handleVaultCas(req: any, res: any): Promise<void> {
    try {
      // 1. Extract the vault-relative path from the '/vault-cas/*' wildcard.
      let rawPath = '';
      if (req.params && typeof req.params[0] === 'string') {
        rawPath = req.params[0];
      } else {
        const fullPath = String(req.path || req.url || '');
        const prefix = '/vault-cas/';
        const idx = fullPath.indexOf(prefix);
        if (idx === -1) {
          res.status(400).json({ error: 'missing path', kind: 'cas_bad_request', reason: 'missing-path' });
          return;
        }
        let tail = fullPath.substring(idx + prefix.length);
        const qsIdx = tail.indexOf('?');
        if (qsIdx !== -1) tail = tail.substring(0, qsIdx);
        try {
          rawPath = decodeURIComponent(tail);
        } catch {
          res.status(400).json({ error: 'malformed URL encoding', kind: 'cas_bad_request', reason: 'bad-encoding' });
          return;
        }
      }

      // 2. Normalize + traversal-guard (pure core).
      const norm = normalizeVaultPath(rawPath);
      if (!norm.ok) {
        const status = norm.reason === 'traversal' ? 403 : 400;
        res.status(status).json({
          error: norm.reason === 'traversal' ? 'path traversal refused' : 'missing path',
          kind: 'cas_bad_request',
          reason: norm.reason,
        });
        return;
      }

      // 3. Precondition header (Express lowercases header names).
      const expectedSha = String(req.headers?.['if-match-content-sha256'] ?? '')
        .trim()
        .toLowerCase();

      // 4. New content from the body. An empty text/plain body can arrive as ''
      //    OR, depending on Local REST API's body parser, as {} / undefined when
      //    Content-Length is 0 — all mean "empty file". Coerce those to ''.
      //    Anything else non-string (a genuinely parsed object with keys) is a
      //    real parser problem → 400 (the router then falls back).
      let newContent: unknown = req.body;
      if (newContent == null) {
        newContent = '';
      } else if (typeof newContent === 'object' && Object.keys(newContent as object).length === 0) {
        // {} from an empty body → empty file.
        newContent = '';
      }
      if (typeof newContent !== 'string') {
        res.status(400).json({
          error: 'request body must be the new file content as text',
          kind: 'cas_bad_request',
          reason: 'body-not-text',
        });
        return;
      }

      // 5. Atomic read→decide→write (pure core over the real vault adapter).
      const { status, body } = await performCasWrite({
        adapter: app.vault.adapter,
        path: norm.path,
        expectedSha,
        newContent,
      });
      res.status(status).json(body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] /vault-cas failed:', err);
      res.status(500).json({
        error: 'internal error: ' + ((err as Error).message || String(err)),
        kind: 'cas_error',
      });
    }
  };
}
