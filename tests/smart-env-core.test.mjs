/**
 * Tests for src/handlers/smart-env-core.mjs — the store reader behind
 * GET /smart-env/sources, which lets a diskless router run `find_twin_pages`
 * against this vault.
 *
 * The properties worth pinning are not "does it read files". They are the ones
 * the consumer's correctness rests on:
 *   - the filter keeps EXACTLY the whole-note lines, including against block
 *     records that contain the marker inside their own payload;
 *   - the header line is INERT to the router's parser (it cannot be mistaken
 *     for a record), which is what lets the caller hand over the whole body;
 *   - files are read in SORTED order, because last-wins across two files must
 *     resolve the same here and on disk;
 *   - truncation is LOUD and lands on a file boundary — a partial store that
 *     looked complete would make "no twins found" a statement about the budget;
 *   - an unreadable file is counted, never fatal, and never 404.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  filterSourceLines,
  isStoreFile,
  collectSmartEnvSources,
  SMART_ENV_STORE_DIR,
  SOURCE_LINE_PREFIX,
  HEADER_KIND,
  TRUNCATION,
} from '../src/handlers/smart-env-core.mjs';

/** A whole-note record line, shaped like the real store's. */
const src = (p, vec = [0.1, 0.2]) =>
  `"smart_sources:${p}": {"path":${JSON.stringify(p)},"embeddings":{"m":{"vec":${JSON.stringify(vec)}}}},`;

/**
 * A BLOCK record. Its key field contains the substring `smart_sources:` — this
 * is the real shape that makes a bare `includes()` re-admit 96% of the store.
 */
const block = (p) =>
  `"smart_blocks:${p}#h": {"key":"smart_blocks:${p}#h","text":"about smart_sources: stuff"},`;

/** Adapter double: a plain path→text map, plus paths that throw on read. */
function mockIo(files, { unreadable = [], listThrows = false } = {}) {
  return {
    reads: [],
    async list(dir) {
      if (listThrows) throw new Error('ENOENT');
      assert.equal(dir, SMART_ENV_STORE_DIR, 'the route must only ever list its own store dir');
      return { files: Object.keys(files) };
    },
    async read(p) {
      this.reads.push(p);
      if (unreadable.includes(p)) throw new Error('EBUSY');
      return files[p];
    },
  };
}

describe('filterSourceLines', () => {
  test('keeps whole-note records and drops block records that MENTION the marker', () => {
    const text = [src('wiki/a.md'), block('wiki/a.md'), src('wiki/b.md'), block('wiki/b.md')].join('\n');
    const { text: kept, lines } = filterSourceLines(text);
    assert.equal(lines, 2);
    assert.equal(kept, [src('wiki/a.md'), src('wiki/b.md')].join('\n'));
    assert.ok(!kept.includes('smart_blocks:'));
  });

  test('the prefix test is anchored — a line merely CONTAINING the marker is dropped', () => {
    const { lines } = filterSourceLines(`  "smart_sources:wiki/a.md": {},\nx "smart_sources:b": {},`);
    assert.equal(lines, 0, 'leading whitespace or any other character means it is not a record line');
  });

  test('is idempotent, and yields no trailing newline', () => {
    const once = filterSourceLines([src('wiki/a.md'), block('x')].join('\n')).text;
    assert.equal(filterSourceLines(once).text, once);
    assert.ok(!once.endsWith('\n'));
  });

  test('is total on junk input', () => {
    for (const bad of ['', null, undefined, 42, {}]) {
      assert.deepEqual(filterSourceLines(bad), { text: '', lines: 0 });
    }
  });
});

describe('isStoreFile', () => {
  test('accepts .ajson by basename, rejects everything else', () => {
    assert.ok(isStoreFile('.smart-env/multi/wiki_a_md.ajson'));
    assert.ok(isStoreFile('.smart-env/multi/UPPER.AJSON'));
    assert.ok(!isStoreFile('.smart-env/multi/ajson.json'));
    assert.ok(!isStoreFile('.smart-env/multi/notes.md'));
    // A file named exactly `.ajson` is an extension with no name — not a log,
    // and shipping it would widen the route past "the vector store".
    assert.ok(!isStoreFile('.smart-env/multi/.ajson'));
    for (const bad of ['', null, undefined, 42]) assert.ok(!isStoreFile(bad));
  });
});

describe('collectSmartEnvSources', () => {
  test('emits a header line then the records, and the header is INERT to the parser', async () => {
    const io = mockIo({
      '.smart-env/multi/a.ajson': [src('wiki/a.md'), block('wiki/a.md')].join('\n'),
      '.smart-env/multi/b.ajson': src('wiki/b.md'),
    });
    const { header, body } = await collectSmartEnvSources(io);
    const lines = body.split('\n');

    assert.equal(header.kind, HEADER_KIND);
    assert.equal(header.available, true);
    assert.equal(header.files, 2);
    assert.equal(header.filesRead, 2);
    assert.equal(header.recordLines, 2);
    assert.equal(header.truncated, false);
    assert.deepEqual(JSON.parse(lines[0]), header);

    // THE PROPERTY THE CALLER RELIES ON: the header cannot be read as a record,
    // so the whole body can be handed to the router's parser unsplit.
    assert.ok(!lines[0].startsWith(SOURCE_LINE_PREFIX));
    for (const l of lines.slice(1)) {
      if (l) assert.ok(l.startsWith(SOURCE_LINE_PREFIX));
    }
  });

  test('reads files in SORTED order — last-wins across files must match the disk backend', async () => {
    const io = mockIo({
      '.smart-env/multi/z.ajson': src('wiki/p.md', [9]),
      '.smart-env/multi/a.ajson': src('wiki/p.md', [1]),
      '.smart-env/multi/m.ajson': src('wiki/p.md', [5]),
    });
    const { body } = await collectSmartEnvSources(io);
    assert.deepEqual(io.reads, [
      '.smart-env/multi/a.ajson',
      '.smart-env/multi/m.ajson',
      '.smart-env/multi/z.ajson',
    ]);
    // The LAST line is z's record — a last-wins parser therefore lands on [9],
    // exactly as it would reading the same files sorted off disk.
    const last = body.trim().split('\n').pop();
    assert.ok(last.includes('[9]'));
  });

  test('a missing store is an ORDINARY answer, not an error and never a 404', async () => {
    const { header, body } = await collectSmartEnvSources(mockIo({}, { listThrows: true }));
    assert.equal(header.available, false);
    assert.equal(header.reason, 'store-missing');
    assert.equal(body, `${JSON.stringify(header)}\n`);
    assert.deepEqual(JSON.parse(body.split('\n')[0]), header);
  });

  test('a directory holding no .ajson answers store-empty', async () => {
    const io = mockIo({ '.smart-env/multi/readme.txt': 'x' });
    const { header } = await collectSmartEnvSources(io);
    assert.equal(header.available, false);
    assert.equal(header.reason, 'store-empty');
  });

  test('an unreadable file is COUNTED, and costs only itself', async () => {
    const io = mockIo({
      '.smart-env/multi/a.ajson': src('wiki/a.md'),
      '.smart-env/multi/b.ajson': src('wiki/b.md'),
      '.smart-env/multi/c.ajson': src('wiki/c.md'),
    }, { unreadable: ['.smart-env/multi/b.ajson'] });
    const { header, body } = await collectSmartEnvSources(io);
    assert.equal(header.files, 3);
    assert.equal(header.filesRead, 2);
    assert.equal(header.unreadableFiles, 1);
    assert.equal(header.recordLines, 2);
    assert.ok(body.includes('wiki/a.md') && body.includes('wiki/c.md'));
    assert.ok(!body.includes('wiki/b.md'));
  });

  test('the byte budget truncates LOUDLY, and only on a file boundary', async () => {
    const io = mockIo({
      '.smart-env/multi/a.ajson': src('wiki/a.md'),
      '.smart-env/multi/b.ajson': src('wiki/b.md'),
      '.smart-env/multi/c.ajson': src('wiki/c.md'),
    });
    const one = filterSourceLines(src('wiki/a.md')).text.length + 1;
    const { header, body } = await collectSmartEnvSources(io, { maxBytes: one * 2 });

    assert.equal(header.truncated, true);
    assert.equal(header.truncatedBy, TRUNCATION.BYTES);
    // A file whose bytes were fetched and then DISCARDED for the budget must
    // not be counted as one the body represents: `filesRead === files` beside
    // `truncated: true` is a contradiction the reader cannot resolve.
    assert.ok(header.filesRead < header.files, 'a truncated read must not claim it saw the store');

    // Every emitted record line is WHOLE — a half-written line would make the
    // consumer's parser drop a record it was never told about.
    for (const l of body.split('\n').slice(1)) {
      if (l) assert.ok(l.startsWith(SOURCE_LINE_PREFIX) && l.endsWith(','));
    }
  });

  test('the file-count guard truncates loudly too', async () => {
    const io = mockIo({
      '.smart-env/multi/a.ajson': src('wiki/a.md'),
      '.smart-env/multi/b.ajson': src('wiki/b.md'),
    });
    const { header } = await collectSmartEnvSources(io, { maxFiles: 1 });
    assert.equal(header.truncated, true);
    assert.equal(header.truncatedBy, TRUNCATION.FILES);
    assert.equal(header.filesRead, 1);
    assert.equal(header.files, 2);
  });

  test('the file-count guard counts files ATTEMPTED — unreadable ones still consume it', async () => {
    // It guarded on `filesRead`, which only advances on success. A directory of
    // a hundred thousand unreadable entries was therefore walked in full while
    // the header said `truncated: false`: the counter never moved, so the
    // runaway guard guarded nothing (review round 2, 2026-08-31).
    const paths = ['a', 'b', 'c', 'd'].map((n) => `.smart-env/multi/${n}.ajson`);
    const io = mockIo(Object.fromEntries(paths.map((p) => [p, src('wiki/x.md')])), { unreadable: paths });
    const { header } = await collectSmartEnvSources(io, { maxFiles: 2 });
    assert.equal(io.reads.length, 2, 'it must stop attempting, not merely stop counting');
    assert.equal(header.truncated, true);
    assert.equal(header.truncatedBy, TRUNCATION.FILES);
    assert.equal(header.unreadableFiles, 2);
    assert.equal(header.filesRead, 0);
  });

  test('on an untruncated read the books balance: filesRead + unreadable === files', async () => {
    const io = mockIo({
      '.smart-env/multi/a.ajson': src('wiki/a.md'),
      '.smart-env/multi/b.ajson': block('only-blocks-here'),
      '.smart-env/multi/c.ajson': src('wiki/c.md'),
      '.smart-env/multi/d.ajson': src('wiki/d.md'),
    }, { unreadable: ['.smart-env/multi/c.ajson'] });
    const { header } = await collectSmartEnvSources(io);
    assert.equal(header.truncated, false);
    // A file with nothing to contribute is still fully accounted for.
    assert.equal(header.filesRead + header.unreadableFiles, header.files);
    assert.equal(header.recordLines, 2);
  });

  test('the READ budget bounds what passes through memory, not just what is sent', async () => {
    // A response budget says nothing about how much text was loaded to produce
    // it: the filter throws away ~96% of every file, so 22 MB sent cost 166 MB
    // read on this fleet. Bounding only the output leaves the renderer exposed
    // to a store of any size (review, 2026-08-31).
    const bulky = (p) => [block(`${p}-1`), block(`${p}-2`), src(`wiki/${p}.md`)].join('\n');
    const io = mockIo({
      '.smart-env/multi/a.ajson': bulky('a'),
      '.smart-env/multi/b.ajson': bulky('b'),
      '.smart-env/multi/c.ajson': bulky('c'),
    });
    const oneFile = Buffer.byteLength(bulky('a'), 'utf8');
    const { header } = await collectSmartEnvSources(io, { maxReadBytes: oneFile });

    assert.equal(header.truncated, true);
    assert.equal(header.truncatedBy, TRUNCATION.READ_BYTES);
    // The budget is a FLOOR-STOP: it is checked before the next read, so the
    // total can exceed it by at most one file. It cannot be tighter — a file's
    // size is not known until it has been read.
    assert.equal(header.filesRead, 1);
    assert.equal(header.readBytes, oneFile);
    assert.ok(header.files > header.filesRead, 'and it must not claim it saw the store');
    // The output budget was never near its default — this really is the other one.
    assert.ok(header.bytes < oneFile);
  });

  test('budgets are measured in BYTES, not UTF-16 code units', async () => {
    // Vault paths on this fleet carry accents and emoji. `string.length` counts
    // code units, so a budget stated in bytes would let through roughly twice
    // what it promised on such a store — and an astral character counts 2 for 4.
    const accented = src('wiki/été-🙂.md');
    const io = mockIo({ '.smart-env/multi/a.ajson': accented });
    const { header, body } = await collectSmartEnvSources(io);
    // EXACT: `segments.join('\n')` puts a newline BETWEEN segments, so a single
    // segment weighs exactly itself. The consumer compares this number against
    // the body it received, so an off-by-one here refuses every valid response.
    assert.equal(header.bytes, Buffer.byteLength(accented, 'utf8'));
    assert.equal(header.bytes, Buffer.byteLength(body.slice(body.indexOf('\n') + 1), 'utf8'));
    assert.ok(header.bytes > accented.length, 'the fixture must actually be multi-byte');
  });

  test('a store whose files hold no whole-note record is available with zero records', async () => {
    // AVAILABLE, not unavailable: the store was read and it genuinely holds no
    // whole-note vectors. Those are different facts and the router says them
    // differently — the same distinction find_twin_pages draws at the top level.
    const io = mockIo({ '.smart-env/multi/a.ajson': [block('x'), block('y')].join('\n') });
    const { header, body } = await collectSmartEnvSources(io);
    assert.equal(header.available, true);
    assert.equal(header.recordLines, 0);
    assert.equal(header.filesRead, 1);
    assert.equal(body, `${JSON.stringify(header)}\n`);
  });
});
