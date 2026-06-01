/**
 * Tests for parseOpenParams() in src/handlers/open-params.mjs — the pure
 * query-string parser behind the v0.3.0 `?h=<heading>` / `?reveal=0`
 * navigation params.
 *
 * The parser lives in a plain `.mjs` (imported by open.ts via the tsconfig
 * `allowJs` setting) precisely so this suite runs on EVERY supported Node
 * version. Importing the `.ts` handler directly would require Node >= 23.6
 * type stripping, which broke `npm test` on the Node 20 baseline (codex
 * review 2026-06-02, P2).
 *
 * The rest of open.ts (the Express handler + Obsidian workspace calls) is
 * integration-bound and exercised manually in a running Obsidian.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenParams } from '../src/handlers/open-params.mjs';

describe('parseOpenParams — heading', () => {
  test('no query → null heading', () => {
    assert.deepEqual(parseOpenParams({ query: {} }), { heading: null, reveal: true });
  });

  test('plain heading', () => {
    assert.equal(parseOpenParams({ query: { h: 'Installation' } }).heading, 'Installation');
  });

  test('leading # is stripped (so ?h=%23Foo and ?h=Foo agree)', () => {
    assert.equal(parseOpenParams({ query: { h: '#Foo' } }).heading, 'Foo');
  });

  test('MULTIPLE leading # are stripped (aligns with router normalizeAnchor ^#+)', () => {
    assert.equal(parseOpenParams({ query: { h: '###Foo' } }).heading, 'Foo');
  });

  test('heading is trimmed', () => {
    assert.equal(parseOpenParams({ query: { h: '  Mon Titre  ' } }).heading, 'Mon Titre');
  });

  test('empty / whitespace-only heading → null', () => {
    assert.equal(parseOpenParams({ query: { h: '   ' } }).heading, null);
    assert.equal(parseOpenParams({ query: { h: '' } }).heading, null);
  });

  test('repeated param (array) collapses to first value', () => {
    assert.equal(parseOpenParams({ query: { h: ['First', 'Second'] } }).heading, 'First');
  });

  test('non-string heading → null', () => {
    assert.equal(parseOpenParams({ query: { h: 42 } }).heading, null);
  });
});

describe('parseOpenParams — reveal', () => {
  test('default ON when absent', () => {
    assert.equal(parseOpenParams({ query: {} }).reveal, true);
  });

  test('falsy tokens turn it OFF (case-insensitive)', () => {
    for (const v of ['0', 'false', 'no', 'off', 'OFF', 'False']) {
      assert.equal(parseOpenParams({ query: { reveal: v } }).reveal, false, `reveal=${v}`);
    }
  });

  test('any other value leaves it ON', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'banana', '']) {
      assert.equal(parseOpenParams({ query: { reveal: v } }).reveal, true, `reveal=${v}`);
    }
  });
});

describe('parseOpenParams — URL fallback (no req.query object)', () => {
  test('parses heading + reveal off the raw url', () => {
    const r = parseOpenParams({ url: '/open/wiki%2Ffoo.md?h=Section%20X&reveal=0' });
    assert.equal(r.heading, 'Section X');
    assert.equal(r.reveal, false);
  });

  test('repeated param in the raw URL collapses to the FIRST value (matches req.query path)', () => {
    // codex P3 regression: Object.fromEntries kept the LAST value.
    assert.equal(parseOpenParams({ url: '/open/foo.md?h=First&h=Second' }).heading, 'First');
  });

  test('originalUrl is preferred and a missing query → defaults', () => {
    assert.deepEqual(parseOpenParams({ originalUrl: '/open/wiki%2Ffoo.md' }), {
      heading: null,
      reveal: true,
    });
  });
});

describe('parseOpenParams — robustness', () => {
  test('null / undefined req → defaults, no throw', () => {
    assert.deepEqual(parseOpenParams(null), { heading: null, reveal: true });
    assert.deepEqual(parseOpenParams(undefined), { heading: null, reveal: true });
  });
});
