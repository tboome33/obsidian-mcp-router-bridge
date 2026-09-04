/**
 * Pure logic for the atomic compare-and-swap write route (C1).
 *
 * Kept dependency-free (no `obsidian`, no Express, no vault I/O) so it can be
 * unit-tested in plain Node — same pattern as folder-hiding-core.mjs,
 * presence-core.mjs, open-resolve.mjs. The Express/Obsidian wiring lives in
 * vault-cas.ts and calls into here.
 *
 * The hash MUST match obsidian-mcp-router/src/helpers/content-hash.mjs on the
 * router side: SHA-256 over the UTF-8 bytes of the content, lowercase hex, no
 * normalization. The router uses node:crypto; here we use Web Crypto
 * (crypto.subtle) because an Obsidian plugin runs in the Electron renderer and
 * the bundle externalizes Node builtins. Both suites pin the same known vector
 * (sha256("hello")) so the two implementations cannot drift.
 */

/** Matcher for a well-formed content hash (64 lowercase hex chars). */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * SHA-256 of `content` as UTF-8 bytes, lowercase hex. Async because Web
 * Crypto's digest is async. Runs in the Obsidian renderer (crypto.subtle and
 * TextEncoder are renderer globals).
 *
 * A single leading BOM (U+FEFF) is stripped first — this MUST stay identical to
 * the router's content-hash.mjs. The bridge reads via adapter.read() (which
 * keeps a BOM) while the router's get_file reads via GET /vault → res.text()
 * (which strips it); without this strip a BOM-prefixed file would hash
 * differently on the two sides and every atomic ifMatch write to it would 409
 * forever. See the long note in the router's content-hash.mjs.
 *
 * @param {string} content
 * @returns {Promise<string>} lowercase hex digest
 */
export async function contentSha256(content) {
  const normalized = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * True when `value` is a well-formed content hash.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isContentSha256(value) {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Decide what an atomic CAS write should do, given the precondition and the
 * current on-disk state. Pure — no I/O. The caller (vault-cas.ts) supplies the
 * current content hash (or null when the file is absent) after reading inside
 * the serialization lock, then acts on the returned verdict.
 *
 * Verdicts:
 *   - { action: 'write' }                         — hashes match, safe to write
 *   - { action: 'reject', status, reason, ... }   — do not write; HTTP status + machine reason
 *
 * Reasons (stable, machine-readable — the router branches on these):
 *   - 'bad-precondition'  (400) — the If-Match header is missing/malformed
 *   - 'target-missing'    (409) — precondition expects content, file is absent
 *   - 'content-changed'   (409) — file exists but its hash differs from expected
 *
 * Note there is deliberately NO "expected-absent" mode here: "create only if
 * new" is already served by Local REST API's Apply-If-Content-Preexists header
 * (the router's ifNew). ifMatch is strictly "replace iff content still equals
 * this hash", which is only meaningful for a file that exists.
 *
 * @param {object} args
 * @param {string} args.expectedSha      — the If-Match-Content-Sha256 header value
 * @param {string|null} args.currentSha  — hash of the current file, or null if absent
 * @returns {{action:'write'}|{action:'reject',status:number,reason:string,expectedSha?:string,currentSha?:string|null}}
 */
export function decideCasWrite({ expectedSha, currentSha }) {
  if (!isContentSha256(expectedSha)) {
    return {
      action: 'reject',
      status: 400,
      reason: 'bad-precondition',
    };
  }
  if (currentSha === null || currentSha === undefined) {
    return {
      action: 'reject',
      status: 409,
      reason: 'target-missing',
      expectedSha,
      currentSha: null,
    };
  }
  if (currentSha !== expectedSha) {
    return {
      action: 'reject',
      status: 409,
      reason: 'content-changed',
      expectedSha,
      currentSha,
    };
  }
  return { action: 'write' };
}

/**
 * Normalize + traversal-guard a vault-relative path. Pure. Same posture as
 * open.ts / open-resolve.mjs: collapse backslashes and slash-runs, then reject
 * absolute paths, `..` segments, and drive letters. A false positive just
 * refuses one write; a false negative on a WRITE route could escape the vault,
 * so err strict.
 *
 * ALSO rejects any dot-prefixed segment (`.obsidian/...`, `.smart-env/...`,
 * a bare `.env`, etc.). Obsidian's own vault index ignores dot-folders
 * entirely (see folder-hiding-core.mjs) — they are never real vault content,
 * only Obsidian's own admin state or a plugin's private store. This route
 * writes through `app.vault.adapter`, which — unlike the index — does NOT
 * ignore them, so without this check a caller could reach
 * `.obsidian/plugins/obsidian-local-rest-api/data.json`, the Bearer key file
 * itself. smart-env.ts's route sits behind the identical risk and closes it
 * by taking no path parameter at all; this route accepts an arbitrary path,
 * so the guard closes it here instead (found + fixed 2026-09-04).
 *
 * @param {string} rawPath — the already-URL-decoded wildcard segment
 * @returns {{ ok: true, path: string } | { ok: false, reason: 'missing-path'|'traversal' }}
 */
export function normalizeVaultPath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    return { ok: false, reason: 'missing-path' };
  }
  const path = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.startsWith('..') ||
    /(^|\/)\.\.(\/|$)/.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    /(^|\/)\.[^/]*(\/|$)/.test(path)
  ) {
    return { ok: false, reason: 'traversal' };
  }
  return { ok: true, path };
}

/**
 * Extract the vault-relative path from an Express-ish request hitting the
 * '/vault-cas/*' wildcard. Pure — takes only the fields it reads, so the
 * request→core mapping is unit-testable without Express. Express 4 puts the
 * wildcard match (already URL-decoded) in req.params[0]; the manual fallback
 * parses req.path/req.url and decodes itself.
 *
 * @param {{ params?: unknown[], path?: string, url?: string }} reqLike
 * @returns {{ ok: true, rawPath: string } | { ok: false, reason: 'missing-path'|'bad-encoding' }}
 */
export function extractCasPath(reqLike) {
  const params = reqLike?.params;
  if (params && typeof params[0] === 'string') {
    return { ok: true, rawPath: params[0] };
  }
  const fullPath = String(reqLike?.path || reqLike?.url || '');
  const prefix = '/vault-cas/';
  const idx = fullPath.indexOf(prefix);
  if (idx === -1) return { ok: false, reason: 'missing-path' };
  let tail = fullPath.substring(idx + prefix.length);
  const qsIdx = tail.indexOf('?');
  if (qsIdx !== -1) tail = tail.substring(0, qsIdx);
  try {
    return { ok: true, rawPath: decodeURIComponent(tail) };
  } catch {
    return { ok: false, reason: 'bad-encoding' };
  }
}

/**
 * Coerce the parsed request body into the new-file-content string. An empty
 * text/plain body can surface as '', null/undefined, or an empty parse
 * artifact ({} / []) depending on the body parser — all of which mean "write
 * an empty file". A non-empty non-string means the parser genuinely produced
 * something that is not our content → null (caller responds 400 body-not-text
 * and the router falls back to its core-PUT tier).
 *
 * @param {unknown} body
 * @returns {string|null} the content string, or null when unusable
 */
export function coerceCasBody(body) {
  if (typeof body === 'string') return body;
  if (body == null) return '';
  if (typeof body === 'object' && Object.keys(body).length === 0) return '';
  return null;
}

/**
 * Normalize the If-Match-Content-Sha256 header value for comparison: absent
 * → '', surrounding whitespace trimmed, uppercase hex folded to lowercase
 * (digest('hex') is lowercase; we accept clients that shout).
 *
 * @param {unknown} headerValue
 * @returns {string}
 */
export function normalizeExpectedSha(headerValue) {
  return String(headerValue ?? '').trim().toLowerCase();
}

/**
 * Module-level serialization for the CAS critical section. The queue itself
 * never rejects, so one failed write cannot poison later ones. Mirrors the
 * renderQueue mutex in templates-execute.ts. Kept here (not in the .ts handler)
 * so it is unit-testable in plain Node.
 */
let casQueue = Promise.resolve();

/**
 * Run `task` mutually exclusive with every other withCasLock call. Serializing
 * the read→compare→write section means no other CAS write can interleave
 * between our read and our write.
 *
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withCasLock(task) {
  const myTurn = casQueue.then(() => task());
  casQueue = myTurn.then(
    () => undefined,
    () => undefined,
  );
  return myTurn;
}

/**
 * The atomic compare-and-swap write, as a pure function over an injected
 * `adapter` ({ exists, read, write }). No Express, no Obsidian import — so the
 * whole read→decide→write path is unit-testable with an in-memory adapter.
 *
 * Runs inside withCasLock, so it is serialized against every other CAS write.
 * The current-content read is wrapped: if the file vanishes between exists()
 * and read() (a concurrent DELETE/rename — a mini-TOCTOU), or is otherwise
 * unreadable, we treat it as ABSENT, so decideCasWrite returns a clean 409
 * target-missing instead of the handler surfacing an opaque 500.
 *
 * @param {object} args
 * @param {{ exists: (p:string)=>Promise<boolean>, read:(p:string)=>Promise<string>, write:(p:string,d:string)=>Promise<void> }} args.adapter
 * @param {string} args.path         — normalized, traversal-guarded vault path
 * @param {string} args.expectedSha  — the If-Match-Content-Sha256 value
 * @param {string} args.newContent   — the full new file content
 * @returns {Promise<{ status: number, body: object }>}
 */
export function performCasWrite({ adapter, path, expectedSha, newContent }) {
  return withCasLock(async () => {
    let currentSha = null;
    try {
      if (await adapter.exists(path)) {
        currentSha = await contentSha256(await adapter.read(path));
      }
    } catch {
      // Vanished or unreadable between exists() and read() → treat as absent.
      // A spurious target-missing 409 is safe (no write; caller re-reads);
      // surfacing a 500 would deny the router its clean fallback path.
      currentSha = null;
    }

    const verdict = decideCasWrite({ expectedSha, currentSha });
    if (verdict.action === 'reject') {
      if (verdict.status === 400) {
        return {
          status: 400,
          body: {
            error: 'If-Match-Content-Sha256 header is missing or malformed (expected 64 lowercase hex chars)',
            kind: 'cas_bad_request',
            reason: verdict.reason,
          },
        };
      }
      return {
        status: 409,
        body: {
          error:
            verdict.reason === 'target-missing'
              ? 'precondition failed: target file no longer exists'
              : 'precondition failed: file content changed since it was read',
          kind: 'cas_conflict',
          reason: verdict.reason,
          expectedSha: verdict.expectedSha,
          currentSha: verdict.currentSha,
        },
      };
    }

    await adapter.write(path, newContent);
    return {
      status: 200,
      body: {
        ok: true,
        path,
        bytesWritten: new TextEncoder().encode(newContent).length,
        contentSha256: await contentSha256(newContent),
      },
    };
  });
}
