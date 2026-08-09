/**
 * Tests for src/conformance-core.mjs — the open-time vault conformance check.
 *
 * The branches the feature is defined by are all exercised through
 * `runOpenCheck` with injected effects, so "a Notice was produced" and "nothing
 * was said" are observed by EXECUTION, not asserted about source text:
 *
 *   1. a managed vault missing an index    → notify called
 *   2. a conformant managed vault          → notify never called
 *   3. the switch OFF                      → nothing read, notify never called
 *   4. a vault the router does not manage  → notify never called
 *
 * Further suites pin the pieces those branches rest on: the copied constants
 * (the projection marker, the scaffold names, the index path) and the
 * expected-path rule, plus the marker check covering EVERY expected projection.
 * NOTE the reach of those constant pins, honestly: they compare a bridge
 * constant to a bridge literal, so they catch a LOCAL edit here — they do NOT
 * observe the router and cannot detect a drift on its side (a cross-repo pin
 * would be false-reliable in this repo's CI, which carries no router source; see
 * src/conformance-core.mjs's header).
 *
 * The Obsidian-bound wiring (src/conformance.ts) is a four-effect adapter with
 * no rules of its own; it is exercised manually in a running Obsidian, like
 * src/folder-hiding.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_PATH,
  MARKER_READ_CONCURRENCY,
  PROJECTION_MARKER,
  ROOT_INDEX_PATH,
  SCAFFOLD_CANDIDATES,
  SEARCH_INDEX_PATH,
  conformanceReport,
  expectedProjectionPaths,
  hasProjectionMarker,
  hasRouterScaffold,
  isProjectionPath,
  isWikiContentPath,
  noticeForReport,
  runOpenCheck,
  statusLineForReport,
} from '../src/conformance-core.mjs';

const MARKED = (title) =>
  `# ${title}\n\n> ${PROJECTION_MARKER} — index de navigation généré (projection OKF §6/§7). ` +
  'Ne pas éditer à la main, ne pas wikilinker.\n\n* [A](a.md) - desc\n';

/** The scaffold that makes a vault router-managed. */
const SCAFFOLD = { 'wiki-meta/catalog.md': '# Wiki Catalog\n' };

/** Drive runOpenCheck over an in-memory vault and record every effect. */
function harness(files, { enabled = true, searchIndex = false, unreadable = [] } = {}) {
  const reads = [];
  const notices = [];
  const existsProbes = [];
  const run = () =>
    runOpenCheck({
      enabled,
      listMarkdownPaths: () => Object.keys(files),
      readFile: async (path) => {
        reads.push(path);
        if (unreadable.includes(path)) throw new Error('locked');
        return Object.prototype.hasOwnProperty.call(files, path) ? files[path] : null;
      },
      fileExists: async (path) => { existsProbes.push(path); return searchIndex; },
      notify: (message) => notices.push(message),
    });
  return { run, reads, notices, existsProbes };
}

// ---------------------------------------------------------------------------
// The four branches
// ---------------------------------------------------------------------------

describe('runOpenCheck — the four branches', () => {
  test('1. a managed vault missing a directory index PRODUCES a Notice', async () => {
    const { run, notices } = harness({
      ...SCAFFOLD,
      'wiki/notes/alpha.md': '# Alpha\n',
      'wiki/index.md': MARKED('Vault'),
      'wiki/log.md': MARKED('Update Log'),
      // wiki/notes/index.md deliberately absent
    });

    const report = await run();

    assert.equal(report.status, 'incomplete');
    assert.deepEqual(report.missing, ['wiki/notes/index.md']);
    assert.equal(notices.length, 1, 'exactly one Notice');
    assert.match(notices[0], /wiki\/notes\/index\.md/, 'the Notice must name what is missing');
    assert.match(notices[0], /ne génère rien|never/i, 'the Notice must say the plugin does not repair');
  });

  test('1b. a managed vault with NO projections at all produces a Notice listing them', async () => {
    const { run, notices } = harness({ ...SCAFFOLD, 'wiki/notes/alpha.md': '# Alpha\n' });

    const report = await run();

    assert.deepEqual(report.missing, ['wiki/index.md', 'wiki/log.md', 'wiki/notes/index.md']);
    assert.equal(notices.length, 1);
  });

  test('1c. an UNMARKED index anywhere in the tree counts as non-conformant', async () => {
    // Not just the root: the router classifies an unmarked file at a reserved
    // path as a CONFLICT and refuses to overwrite it. A bridge that called the
    // vault conformant would have the two halves of this feature disagreeing
    // about the same file.
    const { run, notices } = harness({
      ...SCAFFOLD,
      'wiki/notes/alpha.md': '# Alpha\n',
      'wiki/index.md': MARKED('Vault'),
      'wiki/log.md': MARKED('Update Log'),
      'wiki/notes/index.md': '# My own index\n\nHand-written, not yours.\n',
    });

    const report = await run();

    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.unmarked, ['wiki/notes/index.md']);
    assert.equal(report.status, 'incomplete');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /non marqué/);
  });

  test('2. a conformant managed vault is SILENT', async () => {
    const { run, notices } = harness({
      ...SCAFFOLD,
      'wiki/notes/alpha.md': '# Alpha\n',
      'wiki/notes/index.md': MARKED('notes'),
      'wiki/index.md': MARKED('Vault'),
      'wiki/log.md': MARKED('Update Log'),
    });

    const report = await run();

    assert.equal(report.status, 'conformant');
    assert.deepEqual(report.missing, []);
    assert.deepEqual(report.unmarked, []);
    assert.deepEqual(report.unreadable, []);
    assert.deepEqual(notices, [], 'a conformant vault must produce no Notice');
  });

  test('3. the switch OFF means nothing runs at all', async () => {
    const { run, reads, notices, existsProbes } = harness(
      { ...SCAFFOLD, 'wiki/notes/alpha.md': '# Alpha\n' }, // maximally non-conformant
      { enabled: false },
    );

    const report = await run();

    assert.equal(report, null, 'OFF returns null, not a report');
    assert.deepEqual(reads, [], 'OFF must not read a single file');
    assert.deepEqual(existsProbes, [], 'OFF must not probe either');
    assert.deepEqual(notices, [], 'OFF must be perfectly silent');
  });

  test('4. a vault the router does not manage is SILENT — even with a hand-made wiki/', async () => {
    // The false-accusation case. Plenty of people have a folder called `wiki`
    // in a vault the router has never touched; telling them, on every open, that
    // it is broken is both untrue and rude.
    const { run, notices, reads } = harness({
      'wiki/notes/alpha.md': '# Alpha\n',
      'wiki/deep/tree/page.md': '# Page\n',
      'Notes/journal.md': '# Journal\n',
    });

    const report = await run();

    assert.equal(report.status, 'not-managed');
    assert.deepEqual(notices, [], 'a vault we do not manage must never be nagged');
    assert.deepEqual(reads, [], 'and must not even be read');
  });

  test('4b. a legacy scaffold name (pre-0.58.0 wiki-meta/index.md) still counts as managed', async () => {
    const { run, notices } = harness({
      'wiki-meta/index.md': '# Wiki Index\n',
      'wiki/notes/alpha.md': '# Alpha\n',
    });
    const report = await run();
    assert.equal(report.status, 'incomplete', 'an un-migrated vault is still ours to check');
    assert.equal(notices.length, 1);
  });
});

describe('an EMPTY managed vault is conformant, not "not a wiki"', () => {
  test('scaffold + root projections + zero content pages → conformant', async () => {
    // Exactly what the provisioner writes into a newborn vault. Calling that
    // "not a wiki" would report every freshly-created vault as out of scope.
    const { run, notices } = harness({
      ...SCAFFOLD,
      'wiki/index.md': MARKED('Vault'),
      'wiki/log.md': MARKED('Update Log'),
    });

    const report = await run();

    assert.equal(report.status, 'conformant');
    assert.equal(report.contentPages, 0);
    assert.equal(report.expected, 2, 'the root index and the log are still expected');
    assert.deepEqual(notices, []);
  });

  test('scaffold with NO projections at all → incomplete, not silent', async () => {
    const { run, notices } = harness(SCAFFOLD);
    const report = await run();
    assert.equal(report.status, 'incomplete');
    assert.deepEqual(report.missing, [ROOT_INDEX_PATH, LOG_PATH]);
    assert.equal(notices.length, 1);
  });
});

describe('the search-index sub-status — PRESENCE only', () => {
  test('reports it present when the probe says so', async () => {
    const { run, existsProbes } = harness(
      { ...SCAFFOLD, 'wiki/index.md': MARKED('V'), 'wiki/log.md': MARKED('L') },
      { searchIndex: true },
    );
    const report = await run();
    assert.equal(report.searchIndexPresent, true);
    assert.deepEqual(existsProbes, [SEARCH_INDEX_PATH]);
  });

  test('reports it absent otherwise, and the status line says who builds it', async () => {
    const { run } = harness({ ...SCAFFOLD, 'wiki/index.md': MARKED('V'), 'wiki/log.md': MARKED('L') });
    const report = await run();
    assert.equal(report.searchIndexPresent, false);
    assert.match(statusLineForReport(report, true), /No local search index yet/);
    assert.match(statusLineForReport(report, true), /the router builds it/);
  });

  test('never reads the index — version and freshness are the router’s business', async () => {
    const { run, reads } = harness({ ...SCAFFOLD, 'wiki/index.md': MARKED('V'), 'wiki/log.md': MARKED('L') });
    await run();
    assert.equal(reads.includes(SEARCH_INDEX_PATH), false);
  });
});

describe('runOpenCheck — reads every expected projection, bounded', () => {
  test('reads ALL expected projections that are present, and nothing else', async () => {
    const { run, reads } = harness({
      ...SCAFFOLD,
      'wiki/a/b/c/page.md': '# Page\n',
      'wiki/index.md': MARKED('Vault'),
      'wiki/a/index.md': MARKED('a'),
      'wiki/a/b/index.md': MARKED('b'),
      'wiki/a/b/c/index.md': MARKED('c'),
      'wiki/log.md': MARKED('Update Log'),
    });

    await run();

    assert.deepEqual(reads.slice().sort(), [
      'wiki/a/b/c/index.md',
      'wiki/a/b/index.md',
      'wiki/a/index.md',
      'wiki/index.md',
      'wiki/log.md',
    ]);
    assert.equal(reads.includes('wiki/a/b/c/page.md'), false, 'content pages are never read');
  });

  test('never exceeds the concurrency bound', async () => {
    const files = { ...SCAFFOLD, 'wiki/index.md': MARKED('V'), 'wiki/log.md': MARKED('L') };
    for (let i = 0; i < 40; i += 1) {
      files[`wiki/d${i}/page.md`] = '# p\n';
      files[`wiki/d${i}/index.md`] = MARKED(`d${i}`);
    }
    let inFlight = 0;
    let peak = 0;
    await runOpenCheck({
      enabled: true,
      listMarkdownPaths: () => Object.keys(files),
      readFile: async (p) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight -= 1;
        return files[p] ?? null;
      },
      fileExists: async () => false,
      notify: () => {},
    });
    assert.ok(peak > 1, 'reads must actually run in parallel');
    assert.ok(peak <= MARKER_READ_CONCURRENCY, `peak ${peak} exceeded the bound ${MARKER_READ_CONCURRENCY}`);
  });

  test('an unreadable projection is reported as unreadable, never as conformant', async () => {
    const { run, notices } = harness(
      { ...SCAFFOLD, 'wiki/a.md': '# A\n', 'wiki/index.md': MARKED('V'), 'wiki/log.md': MARKED('L') },
      { unreadable: [LOG_PATH] },
    );
    const report = await run();
    assert.deepEqual(report.unreadable, [LOG_PATH]);
    assert.equal(report.status, 'incomplete');
    assert.equal(notices.length, 1);
    assert.match(notices[0], /illisible/);
  });

  test('writes nothing: the only injected effects are read, exists and notify', async () => {
    const report = await runOpenCheck({
      enabled: true,
      listMarkdownPaths: () => ['wiki-meta/catalog.md', 'wiki/a.md'],
      readFile: async () => null,
      notify: () => {},
    });
    assert.equal(report.status, 'incomplete');
    assert.equal(report.searchIndexPresent, false, 'an absent fileExists probe degrades to "not present"');
  });
});

// ---------------------------------------------------------------------------
// The copied constants
// ---------------------------------------------------------------------------

describe('copied constants — pinned to their expected LOCAL literal', () => {
  test('the marker is EXACTLY the router’s PROJECTION_MARKER', () => {
    // LOCAL-EDIT GUARD, not a cross-repo pin. This asserts the bridge constant
    // equals the literal the router uses; it catches a careless edit HERE. It
    // does not read the router and cannot fail if the router drifts — keeping
    // the two equal is manual discipline (see the core module header).
    assert.equal(PROJECTION_MARKER, 'Generated by obsidian-mcp-router');
  });

  test('the scaffold candidates are EXACTLY the router’s scaffoldCandidates("catalog")', () => {
    // src/helpers/wiki-meta-scaffolds.mjs, current name first, legacy second.
    assert.deepEqual(SCAFFOLD_CANDIDATES, ['wiki-meta/catalog.md', 'wiki-meta/index.md']);
  });

  test('the search-index path is the router’s SEARCH_INDEX_PATH', () => {
    assert.equal(SEARCH_INDEX_PATH, 'wiki-meta/search-index.json');
  });

  test('recognises the router’s real marker line shape', () => {
    assert.equal(hasProjectionMarker(MARKED('x')), true);
  });

  test('is not fooled by a page that merely QUOTES the marker far down', () => {
    const quoting = `${'filler\n'.repeat(30)}> ${PROJECTION_MARKER} — quoted in a doc\n`;
    assert.equal(hasProjectionMarker(quoting), false);
  });

  test('requires the blockquote prefix', () => {
    assert.equal(hasProjectionMarker(`${PROJECTION_MARKER} — no blockquote\n`), false);
  });

  test('handles non-strings and empties', () => {
    assert.equal(hasProjectionMarker(null), false);
    assert.equal(hasProjectionMarker(''), false);
    assert.equal(hasProjectionMarker(42), false);
  });
});

describe('hasRouterScaffold', () => {
  test('either candidate counts', () => {
    assert.equal(hasRouterScaffold(['wiki-meta/catalog.md']), true);
    assert.equal(hasRouterScaffold(['wiki-meta/index.md']), true);
  });

  test('a hand-made wiki/ is not a scaffold', () => {
    assert.equal(hasRouterScaffold(['wiki/a.md', 'wiki/index.md', 'wiki/log.md']), false);
  });

  test('other wiki-meta files are not the scaffold', () => {
    assert.equal(hasRouterScaffold(['wiki-meta/hot.md', 'wiki-meta/journal.md']), false);
  });

  test('folds windows separators and tolerates junk', () => {
    assert.equal(hasRouterScaffold(['wiki-meta\\catalog.md']), true);
    assert.equal(hasRouterScaffold(null), false);
  });
});

describe('path classification', () => {
  test('reserved projection paths, exact lowercase basenames only', () => {
    assert.equal(isProjectionPath('wiki/index.md'), true);
    assert.equal(isProjectionPath('wiki/a/index.md'), true);
    assert.equal(isProjectionPath('wiki/a/b/index.md'), true);
    assert.equal(isProjectionPath('wiki/log.md'), true);
    assert.equal(isProjectionPath('wiki/a/log.md'), false, "a user's own log page is content");
    assert.equal(isProjectionPath('wiki/Index.md'), false, 'Index.md is somebody’s page');
    assert.equal(isProjectionPath('Notes/index.md'), false);
  });

  test('folds windows separators', () => {
    assert.equal(isProjectionPath('wiki\\a\\index.md'), true);
    assert.equal(isWikiContentPath('wiki\\a\\page.md'), true);
  });

  test('content excludes projections and anything outside wiki/', () => {
    assert.equal(isWikiContentPath('wiki/a/page.md'), true);
    assert.equal(isWikiContentPath('wiki/a/index.md'), false);
    assert.equal(isWikiContentPath('wiki-meta/hot.md'), false);
    assert.equal(isWikiContentPath('Notes/page.md'), false);
    assert.equal(isWikiContentPath('wiki/page.txt'), false);
  });
});

describe('expectedProjectionPaths', () => {
  test('root + log + every ANCESTOR directory, intermediates included', () => {
    assert.deepEqual(expectedProjectionPaths(['wiki/a/b/c/page.md']), [
      'wiki/a/b/c/index.md',
      'wiki/a/b/index.md',
      'wiki/a/index.md',
      'wiki/index.md',
      'wiki/log.md',
    ]);
  });

  test('a page at the wiki root needs only the root index and the log', () => {
    assert.deepEqual(expectedProjectionPaths(['wiki/page.md']), ['wiki/index.md', 'wiki/log.md']);
  });

  test('no content still expects the two root files (a newborn vault has them)', () => {
    assert.deepEqual(expectedProjectionPaths([]), ['wiki/index.md', 'wiki/log.md']);
  });

  test('deduplicates across sibling pages', () => {
    assert.deepEqual(expectedProjectionPaths(['wiki/a/one.md', 'wiki/a/two.md']), [
      'wiki/a/index.md',
      'wiki/index.md',
      'wiki/log.md',
    ]);
  });
});

describe('noticeForReport', () => {
  test('null for every silent state', () => {
    assert.equal(noticeForReport({ status: 'conformant', missing: [], unmarked: [] }), null);
    assert.equal(noticeForReport({ status: 'not-managed', missing: [], unmarked: [] }), null);
    assert.equal(noticeForReport(null), null);
    assert.equal(noticeForReport({ failed: true }), null, 'a failed check is not a Notice');
  });

  test('caps a long list rather than filling the screen', () => {
    const missing = ['wiki/a/index.md', 'wiki/b/index.md', 'wiki/c/index.md', 'wiki/d/index.md', 'wiki/e/index.md'];
    const message = noticeForReport({ status: 'incomplete', missing, unmarked: [] });
    assert.match(message, /\(\+2\)/);
    assert.equal(message.includes('wiki/e/index.md'), false);
  });
});

describe('statusLineForReport', () => {
  test('OFF says so, whatever the last report was', () => {
    assert.match(statusLineForReport({ status: 'incomplete', missing: ['x'], unmarked: [] }, false), /disabled/i);
  });

  test('ON with no report yet says it has not run', () => {
    assert.match(statusLineForReport(null, true), /Not checked yet/i);
  });

  test('a FAILED check is its own state — not conformant, not out of scope', () => {
    const line = statusLineForReport({ failed: true, error: 'adapter exploded' }, true);
    assert.match(line, /Check FAILED/);
    assert.match(line, /adapter exploded/);
    assert.match(line, /not a verdict/i);
    assert.match(line, /Re-check/);
  });

  test('names the counts on a conformant vault, the paths on an incomplete one', () => {
    assert.match(
      statusLineForReport(
        { status: 'conformant', missing: [], unmarked: [], unreadable: [], expected: 3, contentPages: 4 }, true,
      ),
      /3 navigation file\(s\) present for 4 page\(s\)/,
    );
    assert.match(
      statusLineForReport({ status: 'incomplete', missing: ['wiki/a/index.md'], unmarked: [], unreadable: [] }, true),
      /wiki\/a\/index\.md/,
    );
  });

  test('an unmanaged vault is described as out of scope, not as broken', () => {
    assert.match(
      statusLineForReport(
        { status: 'not-managed', missing: [], unmarked: [], unreadable: [], expected: 0, contentPages: 0 }, true,
      ),
      /nothing to check/i,
    );
  });
});

describe('conformanceReport — shape', () => {
  test('counts content pages and expected files', () => {
    const report = conformanceReport({
      mdPaths: [
        'wiki-meta/catalog.md',
        'wiki/a/one.md', 'wiki/a/two.md',
        'wiki/index.md', 'wiki/a/index.md', 'wiki/log.md',
        'wiki-meta/hot.md',
      ],
      contents: new Map([
        ['wiki/index.md', MARKED('Vault')],
        ['wiki/a/index.md', MARKED('a')],
        ['wiki/log.md', MARKED('Update Log')],
      ]),
    });
    assert.equal(report.contentPages, 2);
    assert.equal(report.expected, 3);
    assert.equal(report.status, 'conformant');
  });

  test('tolerates a missing mdPaths argument', () => {
    assert.equal(conformanceReport({}).status, 'not-managed');
  });
});
