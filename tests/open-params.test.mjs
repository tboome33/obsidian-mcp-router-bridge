/**
 * Tests for parseOpenParams() in src/handlers/open.ts — the pure query-string
 * parser behind the v0.3.0 `?h=<heading>` / `?reveal=0` navigation params.
 *
 * The rest of open.ts (the Express handler + Obsidian workspace calls) is
 * integration-bound and exercised manually in a running Obsidian; this covers
 * the one piece with branching logic.
 *
 * Runs under Node's built-in type stripping (Node >= 23.6, or with
 * --experimental-strip-types) — open.ts has only erasable TS syntax
 * (type-only `import type`, type annotations), so importing it has zero
 * runtime dependency on the `obsidian` module.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenParams } from '../src/handlers/open.ts';

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
