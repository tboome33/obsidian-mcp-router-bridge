/**
 * Tests for resolveOpenTarget() in src/handlers/open-resolve.mjs — the pure
 * resolver behind GET /open: exact path first, then a basename fallback that
 * ENUMERATES the vault and refuses to guess between same-named files.
 *
 * Lives in `.mjs` (imported by open.ts via tsconfig allowJs) so it runs on
 * every supported Node version without TS type-stripping — same rationale as
 * open-params.test.mjs. The Obsidian `app` is mocked.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenTarget } from '../src/handlers/open-resolve.mjs';

// TFile-like factory. `name` = leaf incl. extension; `basename` = without ext.
function tfile(p, extension = 'md') {
  const name = p.slice(p.lastIndexOf('/') + 1);
  const basename = extension ? name.slice(0, name.lastIndexOf('.')) : name;
  return { path: p, name, basename, extension };
}

// app mock: exact map for getAbstractFileByPath + a flat file list for getFiles.
function makeApp({ exact = {}, files = [] } = {}) {
  const calls = { exact: [], getFiles: 0 };
  return {
    calls,
    vault: {
      getAbstractFileByPath(p) {
        calls.exact.push(p);
        return Object.prototype.hasOwnProperty.call(exact, p) ? exact[p] : null;
      },
      getFiles() {
        calls.getFiles += 1;
        return files;
      },
    },
  };
}

describe('resolveOpenTarget — exact', () => {
  test('exact file → status exact, never enumerates', () => {
    const f = tfile('wiki/Projects/note.md');
    const app = makeApp({ exact: { 'wiki/Projects/note.md': f }, files: [f] });
    assert.deepEqual(resolveOpenTarget(app, 'wiki/Projects/note.md'), { status: 'exact', file: f });
    assert.equal(app.calls.getFiles, 0, 'must not enumerate when the exact path hits');
  });

  test('exact folder resolves too', () => {
    const folder = { path: 'wiki/Projects' }; // no extension → folder-like
    const app = makeApp({ exact: { 'wiki/Projects': folder } });
    assert.deepEqual(resolveOpenTarget(app, 'wiki/Projects'), { status: 'exact', file: folder });
  });
});

describe('resolveOpenTarget — basename fallback', () => {
  test('wrong folder, unique basename → corrected', () => {
    const real = tfile('wiki/Projects/KIVIRI/secrets.md');
    const app = makeApp({ files: [real, tfile('wiki/other.md')] });
    assert.deepEqual(
      resolveOpenTarget(app, 'wiki/Projects/KIVIRI/SaaS/secrets.md'),
      { status: 'corrected', file: real },
    );
  });

  test('extensionless request matches a same-named markdown note', () => {
    const real = tfile('wiki/note.md');
    const app = makeApp({ files: [real] });
    assert.deepEqual(resolveOpenTarget(app, 'a/b/note'), { status: 'corrected', file: real });
  });

  test('never crosses to a different extension (foo.md ≠ foo.pdf)', () => {
    const pdf = tfile('assets/foo.pdf', 'pdf');
    const app = makeApp({ files: [pdf] });
    assert.deepEqual(resolveOpenTarget(app, 'wiki/foo.md'), { status: 'not_found' });
  });

  test('no match → not_found', () => {
    const app = makeApp({ files: [tfile('wiki/other.md')] });
    assert.deepEqual(resolveOpenTarget(app, 'wiki/ghost.md'), { status: 'not_found' });
  });
});

describe('resolveOpenTarget — ambiguity (never guesses)', () => {
  test('same basename in two folders → ambiguous + candidates, no file', () => {
    const a = tfile('Clients/A/foo.md');
    const b = tfile('Clients/B/foo.md');
    const app = makeApp({ files: [a, b] });
    const r = resolveOpenTarget(app, 'wrong/foo.md');
    assert.equal(r.status, 'ambiguous');
    assert.deepEqual(r.candidates.sort(), ['Clients/A/foo.md', 'Clients/B/foo.md']);
    assert.ok(!('file' in r), 'must not pick a file when ambiguous');
  });
});

describe('resolveOpenTarget — guards', () => {
  test('empty / non-string → not_found', () => {
    const app = makeApp({});
    for (const bad of ['', null, undefined, 42]) {
      assert.deepEqual(resolveOpenTarget(app, bad), { status: 'not_found' });
    }
  });

  test('missing getFiles → not_found (no throw) when exact misses', () => {
    const app = { vault: { getAbstractFileByPath: () => null } };
    assert.deepEqual(resolveOpenTarget(app, 'wiki/x.md'), { status: 'not_found' });
  });
});
