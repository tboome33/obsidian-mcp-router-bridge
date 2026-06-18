import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenedHtml } from '../src/handlers/open-html.mjs';

test('foreground=false: no redirect, but still a valid status page', () => {
  const html = buildOpenedHtml('my vault', false);
  assert.ok(!html.includes('location.href'), 'must NOT redirect when foreground is off');
  assert.ok(html.includes('Opened in Obsidian.'), 'keeps the status text');
  assert.ok(html.includes('window.close()'), 'keeps the best-effort tab close');
  assert.equal((html.match(/<script>/g) || []).length, 1, 'exactly one script tag');
});

test('foreground=true: redirects to a correctly-encoded obsidian:// URI', () => {
  const html = buildOpenedHtml('opsidian-mcp-router et bridge', true);
  assert.ok(html.includes('location.href='), 'redirects when foreground is on');
  // space => %20 (encodeURIComponent), wrapped as a JS string literal.
  assert.ok(
    html.includes('location.href="obsidian://open?vault=opsidian-mcp-router%20et%20bridge"'),
    'emits the encoded obsidian:// open URI',
  );
});

test('XSS invariant: a hostile vault name cannot break out of the <script> string', () => {
  const hostile = '</script><script>alert(1)</script>';
  const html = buildOpenedHtml(hostile, true);
  // The angle brackets + slashes are percent-encoded by encodeURIComponent...
  assert.ok(html.includes('vault=%3C%2Fscript%3E%3Cscript%3Ealert(1)%3C%2Fscript%3E'), 'hostile chars are percent-encoded');
  // ...so NO raw </script> or <script ...> from the vault name reaches the page.
  assert.ok(!html.includes('vault=</script>'), 'no raw breakout sequence');
  assert.equal((html.match(/<script>/g) || []).length, 1, 'still exactly one (legit) script tag — no injected one');
  assert.equal((html.match(/<\/script>/g) || []).length, 1, 'exactly one closing script tag');
});

test('XSS invariant: quotes and backslashes are neutralised', () => {
  const html = buildOpenedHtml('a"b\\c', true);
  assert.ok(html.includes('vault=a%22b%5Cc'), 'double-quote => %22, backslash => %5C');
  assert.ok(!html.includes('a"b'), 'raw double-quote does not appear in the page');
});

test('nullish vault name does not throw and yields an empty vault param', () => {
  for (const v of [null, undefined, '']) {
    const html = buildOpenedHtml(v, true);
    assert.ok(html.includes('location.href="obsidian://open?vault=";'), `vault= empty for ${String(v)}`);
  }
});
