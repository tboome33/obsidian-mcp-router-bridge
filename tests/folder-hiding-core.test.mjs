/**
 * Tests for src/folder-hiding-core.mjs — the pure helpers behind the cosmetic
 * "hide folders in the file explorer" setting (path normalization, list
 * parsing, CSS-string escaping, stylesheet shape). The Obsidian-bound DOM
 * injection (src/folder-hiding.ts) is integration-bound and exercised manually
 * in a running Obsidian.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HIDDEN_FOLDERS,
  HIDDEN_FOLDERS_STYLE_ID,
  buildHiddenFoldersCss,
  escapeCssStringValue,
  normalizeFolderPath,
  parseFolderList,
} from '../src/folder-hiding-core.mjs';

describe('constants', () => {
  test('default list is the private scaffold folder', () => {
    assert.deepEqual(DEFAULT_HIDDEN_FOLDERS, ['wiki-meta']);
  });

  test('style element id is namespaced to the plugin', () => {
    assert.equal(HIDDEN_FOLDERS_STYLE_ID, 'mcp-router-bridge-hidden-folders');
  });

  test('the default folder is NOT dot-prefixed (a dot-folder would blind the REST API)', () => {
    for (const folder of DEFAULT_HIDDEN_FOLDERS) {
      assert.equal(folder.startsWith('.'), false);
    }
  });
});

describe('normalizeFolderPath', () => {
  test('passes a clean vault-relative path through', () => {
    assert.equal(normalizeFolderPath('wiki-meta'), 'wiki-meta');
    assert.equal(normalizeFolderPath('Archive/2024'), 'Archive/2024');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeFolderPath('  wiki-meta  '), 'wiki-meta');
  });

  test('folds Windows-style separators (data-path is always /-separated)', () => {
    assert.equal(normalizeFolderPath('wiki-meta\\presence'), 'wiki-meta/presence');
  });

  test('collapses duplicate separators and strips leading/trailing ones', () => {
    assert.equal(normalizeFolderPath('/wiki-meta/'), 'wiki-meta');
    assert.equal(normalizeFolderPath('wiki-meta//presence'), 'wiki-meta/presence');
    assert.equal(normalizeFolderPath('///'), '');
  });

  test('keeps a dot-prefixed name but drops . and .. SEGMENTS', () => {
    assert.equal(normalizeFolderPath('.obsidian'), '.obsidian');
    assert.equal(normalizeFolderPath('../escape'), '');
    assert.equal(normalizeFolderPath('wiki-meta/../..'), '');
    assert.equal(normalizeFolderPath('./wiki-meta'), '');
  });

  test('empty / whitespace / non-string → empty string (caller drops it)', () => {
    assert.equal(normalizeFolderPath(''), '');
    assert.equal(normalizeFolderPath('   '), '');
    assert.equal(normalizeFolderPath(undefined), '');
    assert.equal(normalizeFolderPath(null), '');
    assert.equal(normalizeFolderPath(42), '');
    assert.equal(normalizeFolderPath(['wiki-meta']), '');
  });
});

describe('parseFolderList', () => {
  test('splits textarea text on newlines, dropping blank lines', () => {
    assert.deepEqual(parseFolderList('wiki-meta\n\nArchive\n  \n'), ['wiki-meta', 'Archive']);
  });

  test('handles CRLF input', () => {
    assert.deepEqual(parseFolderList('wiki-meta\r\nArchive'), ['wiki-meta', 'Archive']);
  });

  test('does NOT split on commas — "Notes, misc" is a legal folder name', () => {
    assert.deepEqual(parseFolderList('Notes, misc'), ['Notes, misc']);
  });

  test('accepts the stored array form', () => {
    assert.deepEqual(parseFolderList(['wiki-meta', '/Archive/']), ['wiki-meta', 'Archive']);
  });

  test('dedupes after normalization, preserving first-seen order', () => {
    assert.deepEqual(parseFolderList('Archive\nwiki-meta\n/Archive/\nwiki-meta\\'), [
      'Archive',
      'wiki-meta',
    ]);
  });

  test('always returns an array, even for poisoned settings values', () => {
    assert.deepEqual(parseFolderList(null), []);
    assert.deepEqual(parseFolderList(undefined), []);
    assert.deepEqual(parseFolderList(42), ['42']);
    assert.deepEqual(parseFolderList({}), ['[object Object]']);
  });
});

describe('escapeCssStringValue', () => {
  test('escapes the two characters that could close a CSS string', () => {
    assert.equal(escapeCssStringValue('wiki"meta'), 'wiki\\"meta');
    assert.equal(escapeCssStringValue('wiki\\meta'), 'wiki\\\\meta');
  });

  test('escapes a backslash before a quote in the right order', () => {
    // Input \" must become \\\" — not \\" (which would still close the string).
    assert.equal(escapeCssStringValue('\\"'), '\\\\\\"');
  });

  test('control characters become CSS hex escapes with the terminating space', () => {
    assert.equal(escapeCssStringValue('a\nb'), 'a\\a b');
    assert.equal(escapeCssStringValue('a\u0000b'), 'a\\0 b');
    assert.equal(escapeCssStringValue('a\u007fb'), 'a\\7f b');
  });

  test('leaves ordinary path characters untouched', () => {
    assert.equal(escapeCssStringValue('Archive/2024 — notes'), 'Archive/2024 — notes');
  });

  test('coerces non-strings instead of throwing', () => {
    assert.equal(escapeCssStringValue(42), '42');
    assert.equal(escapeCssStringValue(null), 'null');
  });
});

/**
 * Strip every `"…"` string literal (honouring backslash escapes) so what
 * remains is the CSS *structure*. A folder name that stays inside its string
 * literal is harmless no matter what it contains — `{`, `}` and `;` are
 * ordinary characters in there. Injection means the value reached the
 * structure, which is exactly what this exposes.
 *
 * @returns {{ structure: string, balanced: boolean }} balanced=false means a
 *   string literal was left open, i.e. the value DID break out.
 */
function cssStructure(css) {
  let structure = '';
  let inString = false;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (inString) {
      if (ch === '\\') {
        i += 1; // skip the escaped character, whatever it is
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    structure += ch;
  }
  return { structure, balanced: !inString };
}

describe('buildHiddenFoldersCss', () => {
  test('returns empty CSS when the master switch is off', () => {
    assert.equal(buildHiddenFoldersCss(['wiki-meta'], false), '');
  });

  test('returns empty CSS when the list is empty or unusable', () => {
    assert.equal(buildHiddenFoldersCss([], true), '');
    assert.equal(buildHiddenFoldersCss('', true), '');
    assert.equal(buildHiddenFoldersCss('   \n  \n', true), '');
    assert.equal(buildHiddenFoldersCss('../escape', true), '');
  });

  test('hides the folder subtree, its own row, and its descendant rows', () => {
    const css = buildHiddenFoldersCss(['wiki-meta'], true);
    assert.ok(css.includes('.nav-folder:has(> .nav-folder-title[data-path="wiki-meta"])'));
    assert.ok(css.includes('.nav-folder-title[data-path="wiki-meta"]'));
    assert.ok(css.includes('.nav-folder-title[data-path^="wiki-meta/"]'));
    assert.ok(css.includes('.nav-file-title[data-path^="wiki-meta/"]'));
    assert.ok(css.includes('display: none !important'));
  });

  test('the :has() rule is a SEPARATE block from the fallback rule', () => {
    // Load-bearing: a Chromium without :has() support discards the whole rule
    // the unknown selector appears in. If the two selector lists shared one
    // block, the row fallback would die on exactly the old Obsidian builds
    // (minAppVersion 1.0.0) that depend on it.
    const css = buildHiddenFoldersCss(['wiki-meta'], true);
    const blocks = css
      .split('}')
      .map((b) => b.trim())
      .filter(Boolean);
    const hasBlocks = blocks.filter((b) => b.includes(':has('));
    assert.equal(hasBlocks.length, 1, 'exactly one block should mention :has()');
    assert.equal(
      hasBlocks[0].includes('.nav-file-title'),
      false,
      'the :has() block must not carry the fallback selectors',
    );
    const fallback = blocks.find((b) => b.includes('.nav-file-title'));
    assert.ok(fallback, 'a fallback block must exist');
    assert.equal(fallback.includes(':has('), false);
  });

  test('emits one rule pair regardless of how many folders are listed', () => {
    const css = buildHiddenFoldersCss(['wiki-meta', 'Archive/2024'], true);
    const { structure } = cssStructure(css);
    assert.equal(structure.match(/\{/g).length, 2);
    assert.equal(structure.match(/\}/g).length, 2);
    for (const folder of ['wiki-meta', 'Archive/2024']) {
      assert.ok(css.includes(`.nav-folder-title[data-path="${folder}"]`));
      assert.ok(css.includes(`.nav-file-title[data-path^="${folder}/"]`));
    }
  });

  test('normalizes before emitting, so a sloppy entry still matches data-path', () => {
    const css = buildHiddenFoldersCss(' /wiki-meta\\presence/ ', true);
    assert.ok(css.includes('.nav-folder-title[data-path="wiki-meta/presence"]'));
    assert.equal(css.includes('\\\\'), false, 'no stray backslash should survive');
  });

  test('a hostile folder name cannot break out of the selector', () => {
    // The classic injection: close the attribute value and the rule, then
    // restyle the whole app.
    const css = buildHiddenFoldersCss(['wiki"] {} body { display: none } [x="'], true);
    const { structure, balanced } = cssStructure(css);
    assert.ok(balanced, 'every string literal must stay closed');
    // Still exactly the two rules we emit — no extra block was smuggled in.
    assert.equal(structure.match(/\{/g).length, 2);
    assert.equal(structure.match(/\}/g).length, 2);
    assert.ok(css.includes('\\"'), 'the quote must be escaped');
    // The payload survives only as inert text inside the attribute value.
    assert.equal(structure.includes('body'), false);
  });

  test('a newline in a folder name cannot terminate the rule', () => {
    // Reaches the escaper only via the array form; the textarea path splits on
    // newlines first. Either way the value must stay inside the string literal.
    const css = buildHiddenFoldersCss(['wiki\n} body {color:red', 'ok'], true);
    const { structure, balanced } = cssStructure(css);
    assert.ok(balanced, 'every string literal must stay closed');
    assert.equal(structure.match(/\{/g).length, 2);
    assert.equal(structure.match(/\}/g).length, 2);
    assert.equal(structure.includes('color:red'), false);
    assert.ok(css.includes('\\a '), 'the newline must become a CSS hex escape');
  });

  test('carries a comment stating the change is cosmetic', () => {
    const css = buildHiddenFoldersCss(['wiki-meta'], true);
    assert.match(css, /cosmetic only/i);
    assert.match(css, /nothing is renamed/i);
  });
});
