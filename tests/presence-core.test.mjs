/**
 * Tests for src/presence-core.mjs — the pure helpers behind the presence
 * heartbeat (device-id sanitization, fallback id, payload shape, paths).
 * The Obsidian-bound scheduling/IO (src/presence.ts) is integration-bound
 * and exercised manually in a running Obsidian.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRESENCE_DIR,
  PRESENCE_INTERVAL_MS,
  buildPresencePayload,
  presenceFilePath,
  randomDeviceId,
  sanitizeDeviceId,
} from '../src/presence-core.mjs';

describe('constants (shared contract)', () => {
  test('presence dir is a VISIBLE path (LiveSync does not replicate dot-folders by default)', () => {
    assert.equal(PRESENCE_DIR, 'wiki-meta/presence');
    assert.equal(PRESENCE_DIR.includes('/.'), false);
    assert.equal(PRESENCE_DIR.startsWith('.'), false);
  });

  test('heartbeat period is 5 minutes (resolver freshness TTL is 10)', () => {
    assert.equal(PRESENCE_INTERVAL_MS, 300000);
  });
});

describe('sanitizeDeviceId', () => {
  test('lowercases and keeps [a-z0-9-]', () => {
    assert.equal(sanitizeDeviceId('DESKTOP-ABC123'), 'desktop-abc123');
  });

  test('non-allowed runs collapse to a single dash', () => {
    assert.equal(sanitizeDeviceId('Roland’s MacBook Pro'), 'roland-s-macbook-pro');
    assert.equal(sanitizeDeviceId('pc.cabinet_dentaire'), 'pc-cabinet-dentaire');
  });

  test('leading/trailing dashes trimmed', () => {
    assert.equal(sanitizeDeviceId('--host--'), 'host');
    assert.equal(sanitizeDeviceId('***'), '');
  });

  test('empty / whitespace / non-string → empty string (caller uses fallback id)', () => {
    assert.equal(sanitizeDeviceId(''), '');
    assert.equal(sanitizeDeviceId('   '), '');
    assert.equal(sanitizeDeviceId(undefined), '');
    assert.equal(sanitizeDeviceId(42), '');
  });

  test('capped at 63 chars without a trailing dash', () => {
    const long = 'a'.repeat(80);
    assert.equal(sanitizeDeviceId(long).length, 63);
    const dashAt63 = 'a'.repeat(62) + '---' + 'b'.repeat(20);
    const out = sanitizeDeviceId(dashAt63);
    assert.equal(out.endsWith('-'), false);
    assert.ok(out.length <= 63);
  });
});

describe('randomDeviceId', () => {
  test('8 chars of [a-z0-9] by default', () => {
    for (let i = 0; i < 20; i += 1) {
      const id = randomDeviceId();
      assert.match(id, /^[a-z0-9]{8}$/);
    }
  });

  test('honors a custom length', () => {
    assert.match(randomDeviceId(12), /^[a-z0-9]{12}$/);
  });
});

describe('buildPresencePayload', () => {
  const fields = {
    device: 'desktop-abc123',
    vaultName: 'Roland',
    insecurePort: 27163,
    lastSeen: '2026-06-10T12:00:00.000Z',
    bridgeVersion: '0.4.0',
  };

  test('exact key set per the shared contract — nothing more, nothing less', () => {
    const payload = buildPresencePayload(fields);
    assert.deepEqual(payload, fields);
    assert.deepEqual(Object.keys(payload), [
      'device',
      'vaultName',
      'insecurePort',
      'lastSeen',
      'bridgeVersion',
    ]);
  });

  test('serializes to JSON the resolver can parse back', () => {
    const roundTrip = JSON.parse(JSON.stringify(buildPresencePayload(fields)));
    assert.deepEqual(roundTrip, fields);
    assert.equal(typeof roundTrip.insecurePort, 'number');
  });
});

describe('presenceFilePath', () => {
  test('vault-relative <dir>/<deviceId>.json', () => {
    assert.equal(presenceFilePath('desktop-abc123'), 'wiki-meta/presence/desktop-abc123.json');
  });
});
