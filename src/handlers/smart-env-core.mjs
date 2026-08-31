/**
 * GET /smart-env/sources — serve the whole-note records of Smart Connections'
 * vector store, so a router with NO DISK ON THIS MACHINE can run
 * `find_twin_pages` against this vault.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ROUTE HAS TO EXIST AT ALL
 * ---------------------------------------------------------------------------
 * The store lives in `<vault>/.smart-env/multi/`. Obsidian's Local REST API
 * does not serve dot-directories, and that is not an oversight to work around:
 * measured on this vault, `app.vault.getFiles()` returns ZERO entries under
 * `.smart-env`, so Obsidian's own index does not carry them either. The only
 * way in is `vault.adapter`, which is a plugin capability — hence a bridge
 * route rather than anything the router could have done by itself.
 *
 * ---------------------------------------------------------------------------
 * THE BRIDGE UNDERSTANDS NOTHING ABOUT VECTORS, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 * This route does ONE thing to the data: it keeps the lines beginning with
 * `"smart_sources:` and drops the rest. It does not parse a record, resolve a
 * tombstone, apply last-wins, pick a model, or look at a vector. All of that
 * stays in the router's `smart-env-embeddings.mjs`, which is the SINGLE
 * definition of what this store means — so the local-disk backend and this
 * remote backend agree BY CONSTRUCTION rather than by a parity test that could
 * drift. A second implementation here is exactly the divergence to avoid.
 *
 * The filter is not a guess about the format, it is a restatement of the
 * consumer's own first step (`parseAjsonSources` skips every line without that
 * prefix). Measured over 1046 store files on four vaults: parsing the full text
 * and parsing the filtered text produce IDENTICAL record maps — 0 divergences.
 * It is worth doing because the prefix carries 96% of the bulk: on this vault
 * 166 MB collapses to 22 MB, and one sample file is 1.08 MB for five records.
 *
 * ---------------------------------------------------------------------------
 * THE RESPONSE IS NDJSON, AND ITS HEADER IS INERT TO THE PARSER
 * ---------------------------------------------------------------------------
 *   line 1     {"kind":"smart-env-sources","storePath":…,"files":…,…}
 *   lines 2..n the store's own `"smart_sources:…` lines, verbatim, in
 *              sorted-filename order
 *
 * The header line starts with `{`, so the router's parser skips it under the
 * same prefix rule that skips block records: the caller can hand the ENTIRE
 * body to `parseAjsonSources` without pre-splitting it, and cannot accidentally
 * ingest the metadata as a record. Sorted order matters because a page rewritten
 * in two different FILES resolves last-wins, and the disk backend reads its
 * files sorted too — same order in, same answer out.
 *
 * ---------------------------------------------------------------------------
 * THIS ROUTE NEVER ANSWERS 404, FOR THE REASON `/vault-cas` NEVER DOES
 * ---------------------------------------------------------------------------
 * A vault with no Smart Connections is an ORDINARY answer, not an error — most
 * of a fleet is in that state. If it were a 404 it would be indistinguishable
 * from the 404 Express returns when the route is absent entirely, i.e. when the
 * caller is talking to an older bridge. Those two need different words from the
 * router ("this vault has no index" vs "upgrade the bridge"), so the store's
 * absence travels as a 200 whose header says `available: false` with a reason,
 * and 404 is left to mean exactly one thing.
 *
 * ---------------------------------------------------------------------------
 * A TRUNCATED STORE IS NOT A SMALLER VAULT
 * ---------------------------------------------------------------------------
 * The budget below bounds what one request will read. When it bites, the header
 * says `truncated: true` and names what stopped it. It must never be silent:
 * a partial store yields a partial corpus, and a partial corpus that answered
 * `available: true` would report "no twins" about pages it never compared —
 * the same lie the whole tool is built to refuse. Truncation always happens on
 * a FILE boundary (whole filtered files are appended, never a partial one), so
 * the body is never a half-written line.
 */

/** The store directory, hard-wired. This route takes NO path input — see below. */
export const SMART_ENV_STORE_DIR = '.smart-env/multi';

/** The line prefix of a whole-note record. A leading quote is part of it: block
 *  records contain the substring `smart_sources:` inside their own key field,
 *  so a bare `includes()` would re-admit all of them. */
export const SOURCE_LINE_PREFIX = '"smart_sources:';

/** Marker of the first NDJSON line. */
export const HEADER_KIND = 'smart-env-sources';

/**
 * Default budget for the RESPONSE. The largest store measured on this fleet
 * filters down to 22.3 MB, so 64 MB leaves room for a vault several times
 * bigger while still refusing to build an unbounded string.
 */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Default budget for what is READ — a different thing, and the response budget
 * does not imply it.
 *
 * Every `.ajson` is read whole and then filtered, and the filter throws away
 * ~96% of it, so a response budget of 64 MB says nothing about how much text
 * passed through memory to produce it. On this fleet that is 166 MB read for
 * 22 MB sent. Left unbounded, one pathological file would be loaded entirely
 * into Obsidian's renderer before anything could refuse it (review,
 * 2026-08-31). 512 MB is ~3× the largest store measured here.
 */
export const DEFAULT_MAX_READ_BYTES = 512 * 1024 * 1024;

/** Runaway guard on file count; the fleet's largest store holds 803. */
export const DEFAULT_MAX_FILES = 20000;

/** Why a response stopped early. `null` when it did not. */
export const TRUNCATION = Object.freeze({
  BYTES: 'max-bytes',
  READ_BYTES: 'max-read-bytes',
  FILES: 'max-files',
});

/**
 * Keep only the whole-note record lines of one `.ajson` append log.
 *
 * Pure and total. Returns the kept lines joined by `\n`, with NO trailing
 * newline (the caller joins segments). A file with nothing to keep yields ''.
 *
 * @param {string} text Raw file content.
 * @returns {{ text: string, lines: number }}
 */
export function filterSourceLines(text) {
  if (typeof text !== 'string' || !text) return { text: '', lines: 0 };
  const kept = [];
  for (const line of text.split('\n')) {
    if (line.startsWith(SOURCE_LINE_PREFIX)) kept.push(line);
  }
  return { text: kept.join('\n'), lines: kept.length };
}

/**
 * Is this entry one of the store's append logs?
 *
 * The adapter returns vault-relative paths, so the basename is taken here. Only
 * `.ajson` is accepted: the directory also holds the plugin's own bookkeeping,
 * and shipping an unknown file's bytes to a caller would widen the route from
 * "the vector store" to "whatever Smart Connections happens to put here".
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isStoreFile(p) {
  if (typeof p !== 'string' || !p) return false;
  const base = p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
  return base.length > '.ajson'.length && base.toLowerCase().endsWith('.ajson');
}

/**
 * The first NDJSON line. Either the store was read (`available: true`, with the
 * counts) or it was not (`available: false`, with a reason) — never both.
 *
 * @typedef {object} SmartEnvHeader
 * @property {string}  kind        Always {@link HEADER_KIND}.
 * @property {string}  storePath   The directory read, for the caller's message.
 * @property {boolean} available   False means NO store here — not "no vectors".
 * @property {string}  [reason]    `store-missing` | `store-empty`, when unavailable.
 * @property {number}  [files]     `.ajson` logs the store holds.
 * @property {number}  [filesRead] Logs this body represents (see the truncation note).
 * @property {number}  [unreadableFiles]
 * @property {number}  [recordLines] Whole-note record lines carried in the body.
 * @property {number}  [bytes]     UTF-8 size of the record section.
 * @property {number}  [readBytes] UTF-8 size of everything read to produce it.
 * @property {boolean} [truncated]
 * @property {string}  [truncatedBy] One of {@link TRUNCATION}, only when truncated.
 */

/**
 * Read the store through an injected adapter and produce the NDJSON body.
 *
 * `io` is the whole Obsidian surface this needs — `list(dir)` returning
 * `{ files: string[] }` and `read(path)` returning a string. Injecting it keeps
 * this function testable with no Obsidian at all, which is why the handler is
 * a five-line wrapper.
 *
 * A file that cannot be read is COUNTED, never fatal: these are written by a
 * third-party plugin while Obsidian may be mid-write, and one locked file must
 * not cost the other 802. `unreadableFiles` travels in the header so the router
 * can say how much of the store it actually saw.
 *
 * @param {{ list: (dir: string) => Promise<{ files?: string[] }>, read: (p: string) => Promise<string> }} io
 * @param {{ maxBytes?: number, maxFiles?: number }} [opts]
 * @returns {Promise<{ header: SmartEnvHeader, body: string }>} always — see the
 *   "never answers 404" note above. An unavailable store is a header-only body.
 */
export async function collectSmartEnvSources(io, opts = {}) {
  const maxBytes = Number.isInteger(opts.maxBytes) && opts.maxBytes > 0
    ? opts.maxBytes : DEFAULT_MAX_BYTES;
  const maxReadBytes = Number.isInteger(opts.maxReadBytes) && opts.maxReadBytes > 0
    ? opts.maxReadBytes : DEFAULT_MAX_READ_BYTES;
  const maxFiles = Number.isInteger(opts.maxFiles) && opts.maxFiles > 0
    ? opts.maxFiles : DEFAULT_MAX_FILES;

  const unavailable = (reason) => {
    const header = { kind: HEADER_KIND, storePath: SMART_ENV_STORE_DIR, available: false, reason };
    return { header, body: `${JSON.stringify(header)}\n` };
  };

  let listed;
  try {
    listed = await io.list(SMART_ENV_STORE_DIR);
  } catch {
    // Absent OR unreadable. Both mean the same thing to the caller: there are
    // no embeddings to be had here. Most of a fleet has no Smart Connections,
    // so this is an ordinary answer, not an error.
    return unavailable('store-missing');
  }
  const all = Array.isArray(listed && listed.files) ? listed.files.filter(isStoreFile) : [];
  if (all.length === 0) return unavailable('store-empty');

  // Sorted so the last-wins tie between two FILES claiming the same page
  // resolves identically here and on the disk backend.
  const files = [...all].sort();

  const segments = [];
  let bytes = 0;
  let readBytes = 0;
  let recordLines = 0;
  let unreadableFiles = 0;
  let filesRead = 0;
  // FILES WE TRIED, not files we kept. `maxFiles` is a runaway guard, and
  // guarding on `filesRead` meant a directory of a hundred thousand UNREADABLE
  // entries was walked in full while the header reported `truncated: false`:
  // every read failed, so the counter the guard watched never moved (review
  // round 2, 2026-08-31).
  let filesAttempted = 0;
  let truncatedBy = null;

  // BYTES, NOT UTF-16 CODE UNITS. `string.length` counts code units, so a store
  // full of non-ASCII paths (this fleet has plenty) would be measured well under
  // what it actually costs on the wire, and an astral character counts two for
  // four bytes. The budget is stated in bytes, so it is measured in bytes
  // (review, 2026-08-31).
  const size = (s) => Buffer.byteLength(s, 'utf8');

  for (const file of files) {
    if (filesAttempted >= maxFiles) { truncatedBy = TRUNCATION.FILES; break; }
    filesAttempted += 1;
    // The READ budget is a FLOOR-STOP, checked before the next read: what has
    // already passed through memory bounds what may follow, so the total can
    // overshoot by at most ONE file. It cannot be tighter, because a file's size
    // is not known until it has been read — and in particular it cannot bound a
    // single pathological file, only stop the one after it.
    if (readBytes >= maxReadBytes) { truncatedBy = TRUNCATION.READ_BYTES; break; }
    let text;
    try {
      text = await io.read(file);
    } catch {
      unreadableFiles += 1;
      continue;
    }
    readBytes += size(text);
    const { text: kept, lines } = filterSourceLines(text);
    // The response budget is checked BEFORE appending, so the body never exceeds
    // it and never ends mid-line: whole files go in, or the loop stops.
    //
    // `filesRead` is incremented only once the file is FULLY ACCOUNTED FOR —
    // after this check, not before it. Counting at the read would report a file
    // whose bytes were fetched and then discarded as one the answer contains,
    // and `filesRead === files` next to `truncated: true` is a contradiction
    // the reader has no way to resolve.
    // The size the record section WOULD become. `segments.join('\n')` puts a
    // newline BETWEEN segments — n-1 of them, not n — so counting one per
    // segment overstated `bytes` by exactly one, and the consumer now checks
    // that number against the body it received (review round 2, 2026-08-31).
    const nextBytes = kept ? bytes + (segments.length ? 1 : 0) + size(kept) : bytes;
    if (kept && nextBytes > maxBytes) { truncatedBy = TRUNCATION.BYTES; break; }
    filesRead += 1;
    if (!kept) continue;
    segments.push(kept);
    bytes = nextBytes;
    recordLines += lines;
  }

  const header = {
    kind: HEADER_KIND,
    storePath: SMART_ENV_STORE_DIR,
    available: true,
    // Files the store HOLDS, vs files this body actually REPRESENTS. Reporting
    // only one of them would make a truncated read look like a small vault.
    // When `truncated` is false the books balance exactly:
    //   filesRead + unreadableFiles === files
    files: files.length,
    filesRead,
    unreadableFiles,
    recordLines,
    // What the body weighs and what it cost to build it. The consumer checks
    // `recordLines` against what actually arrived, so it has to be exact.
    bytes,
    readBytes,
    truncated: truncatedBy !== null,
    ...(truncatedBy ? { truncatedBy } : {}),
  };

  return { header, body: `${JSON.stringify(header)}\n${segments.join('\n')}` };
}
