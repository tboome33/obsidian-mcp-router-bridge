/**
 * Pure helpers for the cosmetic "hide folders in the file explorer" setting
 * (no Obsidian imports → directly testable with node:test on every supported
 * Node version — same rationale as src/handlers/open-params.mjs).
 *
 * STRICTLY COSMETIC, and that is load-bearing. The only thing this feature
 * ever does is inject a CSS rule that hides file-explorer rows. It never
 * renames a folder, never dot-prefixes one, and never touches Obsidian's
 * index. A dot-folder was explicitly ruled out upstream: Obsidian ignores
 * dot-prefixed folders entirely, so the Local REST API would stop seeing them
 * too and the MCP router could no longer read wiki-meta (hot / catalog /
 * journal). Hiding must therefore stay in the stylesheet, where the REST
 * surface cannot observe it.
 *
 * Obsidian's file explorer tags every row with the vault-relative path:
 *
 *   <div class="nav-folder">                                   ← whole subtree
 *     <div class="nav-folder-title" data-path="wiki-meta">      ← the row
 *     <div class="nav-folder-children">
 *       <div class="nav-file">
 *         <div class="nav-file-title" data-path="wiki-meta/hot.md">
 *
 * so both the folder and everything under it are addressable by attribute
 * selector.
 */

/** id of the injected <style> element. Stable so a stale one can be reaped. */
export const HIDDEN_FOLDERS_STYLE_ID = 'mcp-router-bridge-hidden-folders';

/** Shipped default: the private scaffold folder. */
export const DEFAULT_HIDDEN_FOLDERS = ['wiki-meta'];

/**
 * Normalize one user-typed folder path to the form Obsidian puts in
 * `data-path`: vault-relative, `/`-separated, no leading/trailing separator.
 *
 * Windows users type `wiki-meta\presence`; Obsidian's `data-path` is always
 * `/`-separated, so backslashes are folded rather than left to silently never
 * match. Entries with a `.` or `..` segment are dropped: `data-path` never
 * contains them, so such an entry could only ever be a typo, and dropping it
 * keeps the emitted CSS honest.
 *
 * @param {unknown} raw
 * @returns {string} Normalized path, or '' when nothing usable remains.
 */
export function normalizeFolderPath(raw) {
  if (typeof raw !== 'string') return '';
  const path = raw
    .trim()
    .replace(/\\/g, '/') // Windows-style input → vault-style separator
    .replace(/\/{2,}/g, '/') // collapse duplicate separators
    .replace(/^\/+|\/+$/g, ''); // strip leading/trailing separators
  if (!path) return '';
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return '';
  return path;
}

/**
 * Parse the settings value into a clean, deduped folder list.
 *
 * Accepts the stored `string[]` or the raw textarea text. Text is split on
 * NEWLINES ONLY — deliberately not on commas: `Notes, misc` is a legal
 * Obsidian folder name, and splitting it would make that folder impossible to
 * express. One folder per line is also what the settings UI asks for.
 *
 * @param {unknown} raw `string[]` (stored form) or `string` (textarea form).
 * @returns {string[]} Normalized, deduped, order-preserving folder list.
 */
export function parseFolderList(raw) {
  const items = Array.isArray(raw) ? raw : String(raw ?? '').split(/\r?\n/);
  const seen = new Set();
  const folders = [];
  for (const item of items) {
    const folder = normalizeFolderPath(item);
    if (!folder || seen.has(folder)) continue;
    seen.add(folder);
    folders.push(folder);
  }
  return folders;
}

/**
 * Escape a value for use inside a CSS string literal (`[data-path="…"]`).
 *
 * The folder list is user input that ends up in a selector, so this is a real
 * injection surface: an unescaped `"` would let `wiki"] {} body {display:none}
 * [x="` close the attribute value and restyle the whole app. Backslash and
 * quote are backslash-escaped; control characters (which a pasted value can
 * carry) become CSS hex escapes with the terminating space required by the
 * spec. Same posture as the double-encoding in handlers/open-html.mjs: encode
 * at the boundary, never trust the shape of the input.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function escapeCssStringValue(value) {
  return String(value)
    .replace(/[\\"]/g, '\\$&')
    .replace(/[\u0000-\u001f\u007f]/g, (ch) => '\\' + ch.charCodeAt(0).toString(16) + ' ');
}

/**
 * Build the stylesheet that hides the listed folders in the file explorer.
 * Returns '' when the feature is off or the list is empty — the caller then
 * removes the <style> element entirely rather than leaving an empty one.
 *
 * Two rules are emitted, and they MUST stay in SEPARATE blocks:
 *
 *   1. `.nav-folder:has(> .nav-folder-title[data-path="…"])` hides the whole
 *      subtree in one go (Chromium 105+, i.e. recent Obsidian).
 *   2. A row-by-row fallback (`data-path` exact + `data-path^="folder/"`) for
 *      older Electron builds — `minAppVersion` is 1.0.0, whose Chromium
 *      predates `:has()`.
 *
 * Splitting them is not cosmetic: a browser that cannot parse `:has()` drops
 * the ENTIRE rule it appears in, so merging the two selector lists would take
 * the fallback down with it on exactly the versions that need it.
 *
 * @param {unknown} folders  Stored `string[]` or raw textarea text.
 * @param {boolean} enabled  The master on/off switch.
 * @returns {string} CSS text, or '' when nothing should be hidden.
 */
export function buildHiddenFoldersCss(folders, enabled) {
  if (!enabled) return '';
  const list = parseFolderList(folders);
  if (list.length === 0) return '';

  const subtree = [];
  const rows = [];
  for (const folder of list) {
    const exact = escapeCssStringValue(folder);
    const prefix = escapeCssStringValue(folder + '/');
    subtree.push(`.nav-folder:has(> .nav-folder-title[data-path="${exact}"])`);
    rows.push(`.nav-folder-title[data-path="${exact}"]`);
    rows.push(`.nav-folder-title[data-path^="${prefix}"]`);
    rows.push(`.nav-file-title[data-path^="${prefix}"]`);
  }

  return (
    '/* mcp-router-bridge — cosmetic only. These folders stay fully visible to\n' +
    '   Obsidian indexing, search and the Local REST API; nothing is renamed. */\n' +
    subtree.join(',\n') +
    ' {\n  display: none !important;\n}\n' +
    rows.join(',\n') +
    ' {\n  display: none !important;\n}\n'
  );
}
