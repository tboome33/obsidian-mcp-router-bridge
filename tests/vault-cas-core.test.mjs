/**
 * Tests for the pure CAS logic in src/handlers/vault-cas-core.mjs — the
 * hashing + decide-what-to-do core behind PUT /vault-cas (C1 optimistic
 * concurrency). The Express/Obsidian wiring in vault-cas.ts is a thin adapter
 * over these functions; keeping the logic pure lets it run in plain Node.
 *
 * The KNOWN VECTOR test is load-bearing: it pins the exact digest that the
 * router side (obsidian-mcp-router/src/helpers/content-hash.mjs) must also
 * produce. If either implementation drifts (different encoding, normalization,
 * hash algo), this vector breaks on one side and the mismatch is caught before
 * it ships a "every conditional write spuriously 409s" bug.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  contentSha256,
  isContentSha256,
  decideCasWrite,
  normalizeVaultPath,
  withCasLock,
  performCasWrite,
  extractCasPath,
  coerceCasBody,
  normalizeExpectedSha,
} from '../src/handlers/vault-cas-core.mjs';

// Canonical vectors, shared verbatim with the router suite.
const HELLO = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'; // sha256("hello")
const EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'; // sha256("")

describe('contentSha256 (Web Crypto)', () => {
  test('known vector: "hello"', async () => {
    assert.equal(await contentSha256('hello'), HELLO);
  });

  test('known vector: empty string', async () => {
    assert.equal(await contentSha256(''), EMPTY);
  });

  test('UTF-8 multibyte is hashed by bytes, not code units', async () => {
    // sha256 of the UTF-8 bytes of "é" (0xC3 0xA9).
    assert.equal(
      await contentSha256('é'),
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    );
  });

  test('CRLF vs LF produce DIFFERENT hashes (no normalization)', async () => {
    const crlf = await contentSha256('a\r\nb');
    const lf = await contentSha256('a\nb');
    assert.notEqual(crlf, lf);
  });

  test('a LEADING BOM is stripped → equals the BOM-free hash (MUST match router)', async () => {
    // adapter.read() keeps a BOM; get_file's res.text() strips it. Both hash
    // cores strip the leading BOM so a BOM-prefixed file is not permanently
    // 409-locked on the atomic tier. This vector must equal the router's.
    assert.equal(await contentSha256('﻿hello'), HELLO);
    assert.equal(await contentSha256('﻿'), EMPTY);
  });

  test('a NON-leading U+FEFF is NOT stripped', async () => {
    assert.notEqual(await contentSha256('a﻿b'), await contentSha256('ab'));
  });

  test('pinned astral vector (surrogate pair) — MUST match router suite', async () => {
    // 'é🙂' exercises both a BMP multibyte char and a surrogate pair.
    assert.equal(
      await contentSha256('é🙂'),
      '7382f537af6a53054b6a72792df00fa0be0f5d2e8214db9cd6ebbcc3d57d02b9',
    );
    assert.equal(
      await contentSha256('a🙂b'),
      'ff39f0ecaa28603997510830e3bcd1953150e1ac44cb8637bbbcd2270112a7cd',
    );
  });

  test('pinned LARGE-content vector — no truncation at scale (matches router suite)', async () => {
    assert.equal(
      await contentSha256('wiki '.repeat(10000)),
      '37807f83aa437c33db5eeb3520550e3c0cb50b114aae97e78d8175188cbd4278',
    );
  });

  test('output is always 64 lowercase hex chars', async () => {
    const h = await contentSha256('anything at all');
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('isContentSha256', () => {
  test('accepts a valid 64-hex lowercase digest', () => {
    assert.equal(isContentSha256(HELLO), true);
  });
  test('rejects uppercase, wrong length, non-hex, and non-strings', () => {
    assert.equal(isContentSha256(HELLO.toUpperCase()), false);
    assert.equal(isContentSha256(HELLO.slice(0, 63)), false);
    assert.equal(isContentSha256(HELLO + 'a'), false);
    assert.equal(isContentSha256('zzzz'), false);
    assert.equal(isContentSha256(''), false);
    assert.equal(isContentSha256(null), false);
    assert.equal(isContentSha256(undefined), false);
    assert.equal(isContentSha256(123), false);
  });
});

describe('decideCasWrite', () => {
  test('match → write', () => {
    assert.deepEqual(
      decideCasWrite({ expectedSha: HELLO, currentSha: HELLO }),
      { action: 'write' },
    );
  });

  test('content changed → 409 content-changed with both hashes', () => {
    const v = decideCasWrite({ expectedSha: HELLO, currentSha: EMPTY });
    assert.equal(v.action, 'reject');
    assert.equal(v.status, 409);
    assert.equal(v.reason, 'content-changed');
    assert.equal(v.expectedSha, HELLO);
    assert.equal(v.currentSha, EMPTY);
  });

  test('file absent → 409 target-missing', () => {
    const v = decideCasWrite({ expectedSha: HELLO, currentSha: null });
    assert.equal(v.action, 'reject');
    assert.equal(v.status, 409);
    assert.equal(v.reason, 'target-missing');
    assert.equal(v.currentSha, null);
  });

  test('undefined current (treated as absent) → 409 target-missing', () => {
    const v = decideCasWrite({ expectedSha: HELLO, currentSha: undefined });
    assert.equal(v.action, 'reject');
    assert.equal(v.reason, 'target-missing');
  });

  test('malformed precondition → 400 bad-precondition (checked BEFORE state)', () => {
    // Even with a matching-looking absent file, a bad header short-circuits.
    const v = decideCasWrite({ expectedSha: 'not-a-hash', currentSha: null });
    assert.equal(v.action, 'reject');
    assert.equal(v.status, 400);
    assert.equal(v.reason, 'bad-precondition');
  });

  test('empty precondition → 400 bad-precondition', () => {
    const v = decideCasWrite({ expectedSha: '', currentSha: HELLO });
    assert.equal(v.status, 400);
    assert.equal(v.reason, 'bad-precondition');
  });
});

describe('normalizeVaultPath (traversal guard)', () => {
  test('accepts plain vault-relative paths', () => {
    assert.deepEqual(normalizeVaultPath('a.md'), { ok: true, path: 'a.md' });
    assert.deepEqual(normalizeVaultPath('wiki/notes/x.md'), { ok: true, path: 'wiki/notes/x.md' });
  });
  test('collapses backslashes and slash-runs', () => {
    assert.deepEqual(normalizeVaultPath('a\\b'), { ok: true, path: 'a/b' });
    assert.deepEqual(normalizeVaultPath('a//b'), { ok: true, path: 'a/b' });
  });
  test('rejects traversal, absolute, and drive-letter paths', () => {
    for (const p of ['../etc', '/abs', 'C:/x', 'a/../b', '..', 'a/..']) {
      const r = normalizeVaultPath(p);
      assert.equal(r.ok, false, `expected ${p} rejected`);
      assert.equal(r.reason, 'traversal');
    }
  });
  test('rejects empty / non-string', () => {
    assert.deepEqual(normalizeVaultPath(''), { ok: false, reason: 'missing-path' });
    assert.deepEqual(normalizeVaultPath(null), { ok: false, reason: 'missing-path' });
  });
  // Obsidian ignores dot-prefixed folders entirely (folder-hiding-core.mjs) —
  // they are never real vault content, only ever Obsidian's OWN admin state
  // (.obsidian/) or a plugin's private store (.smart-env/). The traversal
  // guard let a leading-dot segment straight through, so this CAS route could
  // overwrite .obsidian/plugins/obsidian-local-rest-api/data.json — the
  // Bearer key file itself — via app.vault.adapter, which (unlike Obsidian's
  // own vault index) does not ignore dot-folders. smart-env.ts's route sits
  // behind the same risk and closes it by taking NO path parameter at all;
  // this route accepts an arbitrary path, so the guard must close it instead.
  test('rejects a path with any dot-prefixed segment (.obsidian, .smart-env, etc.)', () => {
    for (const p of [
      '.obsidian/plugins/obsidian-local-rest-api/data.json',
      '.smart-env/multi/foo.ajson',
      'wiki/.obsidian/x.md',
      'a/.hidden/b.md',
      '.git/config',
    ]) {
      const r = normalizeVaultPath(p);
      assert.equal(r.ok, false, `expected ${p} rejected`);
      assert.equal(r.reason, 'traversal');
    }
  });
  test('a leaf filename that merely starts with a dot but has no dot SEGMENT is still fine to reject the same way (no special-casing)', () => {
    // Documents the chosen posture: the guard is segment-based, not
    // leaf-only, so `wiki/.env` is refused exactly like `.env` at the root —
    // consistent, not selectively permissive.
    const r = normalizeVaultPath('wiki/.env');
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'traversal');
  });
});

describe('withCasLock (serialization mutex)', () => {
  test('serializes tasks — no two run concurrently', async () => {
    let active = 0;
    let maxActive = 0;
    const order = [];
    const mk = (id) => () =>
      new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`enter-${id}`);
        setTimeout(() => {
          order.push(`exit-${id}`);
          active -= 1;
          resolve(id);
        }, 5);
      });
    // Enqueue three; if they interleaved, maxActive would exceed 1.
    await Promise.all([withCasLock(mk('a')), withCasLock(mk('b')), withCasLock(mk('c'))]);
    assert.equal(maxActive, 1);
    assert.deepEqual(order, ['enter-a', 'exit-a', 'enter-b', 'exit-b', 'enter-c', 'exit-c']);
  });

  test('a rejecting task does not poison the queue — later tasks still run', async () => {
    await assert.rejects(() => withCasLock(async () => { throw new Error('boom'); }));
    const ran = await withCasLock(async () => 'ok');
    assert.equal(ran, 'ok');
  });
});

describe('performCasWrite (read→decide→write orchestration)', () => {
  // In-memory adapter. `files` maps path→content; absent key = missing file.
  function makeAdapter(files, opts = {}) {
    const written = {};
    return {
      written,
      async exists(p) {
        if (opts.existsButUnreadable === p) return true;
        return Object.prototype.hasOwnProperty.call(files, p);
      },
      async read(p) {
        if (opts.existsButUnreadable === p) throw new Error('ENOENT (vanished)');
        if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT');
        return files[p];
      },
      async write(p, d) {
        files[p] = d;
        written[p] = d;
      },
    };
  }

  test('matching hash → 200, writes newContent, echoes its hash', async () => {
    const adapter = makeAdapter({ 'a.md': 'old' });
    const r = await performCasWrite({
      adapter,
      path: 'a.md',
      expectedSha: await contentSha256('old'),
      newContent: 'new',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(adapter.written['a.md'], 'new');
    assert.equal(r.body.contentSha256, await contentSha256('new'));
    assert.equal(r.body.bytesWritten, 3);
  });

  test('mismatch → 409 content-changed, NO write', async () => {
    const adapter = makeAdapter({ 'a.md': 'CURRENT' });
    const r = await performCasWrite({
      adapter,
      path: 'a.md',
      expectedSha: await contentSha256('what-i-read'),
      newContent: 'new',
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'content-changed');
    assert.equal(adapter.written['a.md'], undefined);
  });

  test('absent file → 409 target-missing, NO write', async () => {
    const adapter = makeAdapter({});
    const r = await performCasWrite({
      adapter,
      path: 'gone.md',
      expectedSha: await contentSha256('x'),
      newContent: 'new',
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'target-missing');
    assert.equal(adapter.written['gone.md'], undefined);
  });

  test('file vanishes between exists() and read() → 409 target-missing (not 500)', async () => {
    const adapter = makeAdapter({}, { existsButUnreadable: 'race.md' });
    const r = await performCasWrite({
      adapter,
      path: 'race.md',
      expectedSha: await contentSha256('x'),
      newContent: 'new',
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'target-missing');
  });

  test('empty-string content with a matching hash → 200, writes ""', async () => {
    const adapter = makeAdapter({ 'a.md': 'to-be-cleared' });
    const r = await performCasWrite({
      adapter,
      path: 'a.md',
      expectedSha: await contentSha256('to-be-cleared'),
      newContent: '',
    });
    assert.equal(r.status, 200);
    assert.equal(adapter.written['a.md'], '');
    assert.equal(r.body.bytesWritten, 0);
  });

  test('BOM regression: on-disk BOM + content matches the BOM-free hash the router sent', async () => {
    // The exact bug the review caught: get_file (res.text) strips the BOM, so
    // the router's expectedSha = sha256("hello"). adapter.read keeps the BOM.
    // With the BOM-strip in contentSha256 the two agree and the write applies.
    const adapter = makeAdapter({ 'a.md': '﻿hello' });
    const r = await performCasWrite({
      adapter,
      path: 'a.md',
      expectedSha: await contentSha256('hello'), // == HELLO, BOM-free
      newContent: 'replaced',
    });
    assert.equal(r.status, 200, 'BOM file must be writable via the atomic tier');
    assert.equal(adapter.written['a.md'], 'replaced');
  });

  test('bytesWritten counts UTF-8 BYTES, not JS string length', async () => {
    // 'é🙂' = 2 UTF-16 + surrogate pair = .length 3, but 2+4 = 6 UTF-8 bytes.
    const adapter = makeAdapter({ 'a.md': 'old' });
    const r = await performCasWrite({
      adapter,
      path: 'a.md',
      expectedSha: await contentSha256('old'),
      newContent: 'é🙂',
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.bytesWritten, 6);
    assert.equal(
      r.body.contentSha256,
      '7382f537af6a53054b6a72792df00fa0be0f5d2e8214db9cd6ebbcc3d57d02b9',
    );
  });

  test('CONCURRENCY: two CAS writes racing on the same stale token — exactly one wins', async () => {
    // Codex finding #2: performCasWrite could drop withCasLock and the mutex
    // test + orchestration tests would both stay green. This test pins that
    // performCasWrite itself serializes: two concurrent writes carrying the
    // SAME precondition; without the lock, both would read 'base' during the
    // overlapping window and both would win (two writes, double 200).
    const files = { 'a.md': 'base' };
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    let writes = 0;
    const adapter = {
      async exists(p) {
        return Object.prototype.hasOwnProperty.call(files, p);
      },
      async read(p) {
        await delay(10); // widen the read→write window to force the overlap
        return files[p];
      },
      async write(p, d) {
        writes += 1;
        files[p] = d;
      },
    };
    const token = await contentSha256('base');
    const [r1, r2] = await Promise.all([
      performCasWrite({ adapter, path: 'a.md', expectedSha: token, newContent: 'winner-A' }),
      performCasWrite({ adapter, path: 'a.md', expectedSha: token, newContent: 'winner-B' }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], 'exactly one 200 and one 409');
    assert.equal(writes, 1, 'exactly one adapter.write');
    const loser = r1.status === 409 ? r1 : r2;
    assert.equal(loser.body.reason, 'content-changed');
    const winner = r1.status === 200 ? 'winner-A' : 'winner-B';
    assert.equal(files['a.md'], winner, 'final content is the single winner');
  });
});

describe('extractCasPath (request→core mapping)', () => {
  test('prefers Express params[0] (already decoded)', () => {
    assert.deepEqual(
      extractCasPath({ params: ['wiki/café notes.md'], url: '/ignored' }),
      { ok: true, rawPath: 'wiki/café notes.md' },
    );
  });
  test('manual fallback: parses url, strips query, decodes', () => {
    assert.deepEqual(
      extractCasPath({ url: '/vault-cas/wiki/caf%C3%A9.md?x=1' }),
      { ok: true, rawPath: 'wiki/café.md' },
    );
  });
  test('malformed percent-encoding → bad-encoding', () => {
    const r = extractCasPath({ url: '/vault-cas/bad%zz.md' });
    assert.deepEqual(r, { ok: false, reason: 'bad-encoding' });
  });
  test('missing prefix → missing-path', () => {
    assert.deepEqual(extractCasPath({ url: '/elsewhere/a.md' }), { ok: false, reason: 'missing-path' });
    assert.deepEqual(extractCasPath({}), { ok: false, reason: 'missing-path' });
  });
});

describe('coerceCasBody (body→content mapping)', () => {
  test('strings pass through, including empty string', () => {
    assert.equal(coerceCasBody('content'), 'content');
    assert.equal(coerceCasBody(''), '');
  });
  test('empty-body artifacts (null/undefined/{}/[]) → empty file', () => {
    assert.equal(coerceCasBody(null), '');
    assert.equal(coerceCasBody(undefined), '');
    assert.equal(coerceCasBody({}), '');
    assert.equal(coerceCasBody([]), '');
  });
  test('a genuinely parsed non-empty object → null (400 body-not-text)', () => {
    assert.equal(coerceCasBody({ a: 1 }), null);
    assert.equal(coerceCasBody([1]), null);
    assert.equal(coerceCasBody(42), null);
  });
});

describe('normalizeExpectedSha (header normalization)', () => {
  test('trims and lowercases', () => {
    assert.equal(normalizeExpectedSha('  ABCdef0123  '), 'abcdef0123');
  });
  test('absent header → empty string (→ 400 bad-precondition downstream)', () => {
    assert.equal(normalizeExpectedSha(undefined), '');
    assert.equal(normalizeExpectedSha(null), '');
  });
});
