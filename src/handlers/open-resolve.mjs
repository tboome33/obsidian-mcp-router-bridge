/**
 * resolveOpenTarget — decide WHICH vault file/folder a GET /open/<path>
 * request opens.
 *
 * Two-step resolution (self-healing, mirrors how Obsidian resolves links —
 * but WITHOUT ever guessing between same-named files):
 *   1. EXACT path via `vault.getAbstractFileByPath(normalized)` — the single
 *      source of truth for the traversal-guarded path. Returns a TFile OR a
 *      TFolder (both are openable). → status 'exact'.
 *   2. BASENAME fallback: enumerate every TFile in the vault and keep those
 *      whose leaf name matches the requested basename. So a correct filename in
 *      the WRONG folder still opens the right note instead of 404.
 *        - exactly one match  → status 'corrected' (open that verified TFile)
 *        - zero matches       → status 'not_found' (caller 404s)
 *        - two or more        → status 'ambiguous' (caller 409s with the
 *                                candidates — NEVER silently picks one)
 *
 * Why enumerate rather than `metadataCache.getFirstLinkpathDest`: that API
 * returns a single "first" destination and thus HIDES ambiguity — for a
 * genuinely duplicated basename it would open one arbitrary file. Enumerating
 * lets us refuse (409) instead of guessing wrong. Folders are resolved by exact
 * path only — a basename fallback across folders would be far too ambiguous.
 *
 * Security: the fallback derives the basename from the ALREADY traversal-
 * guarded `normalized` (open.ts rejects `..`, absolute paths, drive letters
 * BEFORE calling this). A leaf basename can't reintroduce a traversal, and the
 * enumeration only ever yields real TFiles INSIDE the vault. The caller opens
 * the returned `file` BY REFERENCE, so the "open a verified vault object"
 * invariant holds.
 *
 * Pure and dependency-free (`.mjs`, imported by open.ts via tsconfig allowJs)
 * so it unit-tests on every supported Node version without TS type-stripping.
 *
 * @param {{ vault?: { getAbstractFileByPath?: (p: string) => any, getFiles?: () => any[] } }} app
 * @param {string} normalized - vault-relative path, already traversal-guarded.
 * @returns {{ status: 'exact'|'corrected', file: any }
 *          | { status: 'ambiguous', candidates: string[] }
 *          | { status: 'not_found' }}
 */
export function resolveOpenTarget(app, normalized) {
  if (!normalized || typeof normalized !== 'string') return { status: 'not_found' };

  // 1. Exact path (files AND folders).
  const getExact = app && app.vault && app.vault.getAbstractFileByPath;
  const exact = typeof getExact === 'function' ? getExact.call(app.vault, normalized) : null;
  if (exact) return { status: 'exact', file: exact };

  // 2. Basename fallback — leaf name of the (guarded) path.
  const slash = normalized.lastIndexOf('/');
  const basename = slash === -1 ? normalized : normalized.slice(slash + 1);
  if (!basename) return { status: 'not_found' };

  const getFiles = app && app.vault && app.vault.getFiles;
  if (typeof getFiles !== 'function') return { status: 'not_found' };
  const all = getFiles.call(app.vault) || [];

  // A request leaf carries the note extension (`secrets.md`) → match TFiles
  // whose `.name` equals it exactly (never crosses to `secrets.pdf`). A rare
  // extensionless leaf (`secrets`) → match a same-named markdown note. Case-
  // sensitive: an exact-path hit already handled the common case, and matching
  // case-insensitively could merge `Foo.md`/`foo.md` into a false single.
  const hasExt = /\.[^./]+$/.test(basename);
  const seen = new Set();
  const candidates = [];
  for (const f of all) {
    if (!f || typeof f.path !== 'string') continue;
    const isMatch =
      f.name === basename ||
      (!hasExt && f.basename === basename && f.extension === 'md');
    if (isMatch && !seen.has(f.path)) {
      seen.add(f.path);
      candidates.push(f);
    }
  }

  if (candidates.length === 1) return { status: 'corrected', file: candidates[0] };
  if (candidates.length === 0) return { status: 'not_found' };
  return { status: 'ambiguous', candidates: candidates.map((f) => f.path) };
}
