/**
 * Tests for the /ping handlers in src/handlers/ping.mjs — the smart-link
 * resolver's local-mirror probe. Asserts the shared contract VERBATIM:
 * GET → 200 {"pong":true}, GET ?v=<name> → 200 only when <name> matches the
 * injected vault name (404 with the same four headers otherwise),
 * OPTIONS → 204 no body, all carrying the four CORS/PNA headers, plus the
 * loopback guard mirrored from /open.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PING_HEADERS,
  makePingGetHandler,
  handlePingOptions,
  isLoopbackRequest,
  extractVaultParam,
} from '../src/handlers/ping.mjs';

/** Vault name with a space + accents — exercises URL-decoding for real. */
const VAULT_NAME = 'Vault Été';
const handlePingGet = makePingGetHandler(() => VAULT_NAME);

/** Minimal Express-response double recording everything the handlers do. */
function mockRes() {
  const res = {
    headers: {},
    statusCode: null,
    jsonBody: undefined,
    ended: false,
    sentBody: undefined,
    contentType: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(obj) {
      this.jsonBody = obj;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    type(t) {
      this.contentType = t;
      return this;
    },
    send(body) {
      this.sentBody = body;
      return this;
    },
  };
  return res;
}

const CONTRACT_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Cache-Control': 'no-store',
};

describe('/ping contract headers', () => {
  test('PING_HEADERS matches the shared contract exactly', () => {
    assert.deepEqual({ ...PING_HEADERS }, CONTRACT_HEADERS);
  });
});

describe('GET /ping', () => {
  test('200 {"pong":true} with the four headers', () => {
    const res = mockRes();
    handlePingGet({ ip: '127.0.0.1' }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { pong: true });
    assert.deepEqual(res.headers, CONTRACT_HEADERS);
  });

  test('body carries NO vault name / version / extra keys (anti-fingerprinting)', () => {
    const res = mockRes();
    handlePingGet({ ip: '::1' }, res);
    assert.deepEqual(Object.keys(res.jsonBody), ['pong']);
  });

  test('IPv4-mapped IPv6 loopback accepted', () => {
    const res = mockRes();
    handlePingGet({ ip: '::ffff:127.0.0.1' }, res);
    assert.equal(res.statusCode, 200);
  });

  test('missing req.ip tolerated (matches /open behavior)', () => {
    const res = mockRes();
    handlePingGet({}, res);
    assert.equal(res.statusCode, 200);
  });

  test('non-loopback refused with 403, no pong, no CORS headers', () => {
    const res = mockRes();
    handlePingGet({ ip: '192.168.0.42' }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonBody, undefined);
    assert.deepEqual(res.headers, {});
  });
});

describe('GET /ping?v=<name> — vault confirmation (multi-vault devices)', () => {
  test('matching name (req.query, already decoded by Express) → 200 pong', () => {
    const res = mockRes();
    handlePingGet({ ip: '127.0.0.1', query: { v: VAULT_NAME } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { pong: true });
    assert.deepEqual(res.headers, CONTRACT_HEADERS);
  });

  test('wrong name → 404 with the four headers, empty body', () => {
    const res = mockRes();
    handlePingGet({ ip: '127.0.0.1', query: { v: 'OtherVault' } }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.headers, CONTRACT_HEADERS); // CORS fetch must read the status
    assert.equal(res.jsonBody, undefined);
    assert.equal(res.sentBody, undefined); // anti-fingerprinting: nothing echoed
    assert.equal(res.ended, true);
  });

  test('encoded space + accents in the raw-URL fallback decoded exactly once → 200', () => {
    const res = mockRes();
    // 'Vault Été' percent-encoded: space → %20, É → %C3%89, é → %C3%A9
    handlePingGet({ ip: '127.0.0.1', url: '/ping?v=Vault%20%C3%89t%C3%A9' }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, { pong: true });
  });

  test('encoded wrong name via raw-URL fallback → 404', () => {
    const res = mockRes();
    handlePingGet({ ip: '127.0.0.1', url: '/ping?v=Autre%20Coffre' }, res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.headers, CONTRACT_HEADERS);
  });

  test('comparison is strict (===): case mismatch → 404', () => {
    const res = mockRes();
    handlePingGet({ ip: '127.0.0.1', query: { v: VAULT_NAME.toLowerCase() } }, res);
    assert.equal(res.statusCode, 404);
  });

  test('empty v (?v=) → 404 (a vault name is never empty)', () => {
    const res = mockRes();
    handlePingGet({ ip: '127.0.0.1', query: { v: '' } }, res);
    assert.equal(res.statusCode, 404);
  });

  test('repeated v keeps the FIRST value (open-params convention)', () => {
    const ok = mockRes();
    handlePingGet({ ip: '127.0.0.1', query: { v: [VAULT_NAME, 'Other'] } }, ok);
    assert.equal(ok.statusCode, 200);

    const ko = mockRes();
    handlePingGet({ ip: '127.0.0.1', query: { v: ['Other', VAULT_NAME] } }, ko);
    assert.equal(ko.statusCode, 404);
  });

  test('vault name unavailable (getter throws) → 404, never a crash', () => {
    const throwing = makePingGetHandler(() => {
      throw new Error('vault not ready');
    });
    const res = mockRes();
    throwing({ ip: '127.0.0.1', query: { v: VAULT_NAME } }, res);
    assert.equal(res.statusCode, 404);

    // ...but a bare GET (no v) never calls the getter → still 200
    const bare = mockRes();
    throwing({ ip: '127.0.0.1' }, bare);
    assert.equal(bare.statusCode, 200);
  });

  test('non-loopback still refused with 403 even with a matching v', () => {
    const res = mockRes();
    handlePingGet({ ip: '192.168.0.42', query: { v: VAULT_NAME } }, res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(res.headers, {});
  });
});

describe('extractVaultParam', () => {
  test('absent → undefined (req.query and raw-URL paths)', () => {
    assert.equal(extractVaultParam({ query: {} }), undefined);
    assert.equal(extractVaultParam({ url: '/ping' }), undefined);
    assert.equal(extractVaultParam({ url: '/ping?reveal=0' }), undefined);
    assert.equal(extractVaultParam(null), undefined);
    assert.equal(extractVaultParam(undefined), undefined);
  });

  test('req.query wins over the raw URL when populated', () => {
    assert.equal(
      extractVaultParam({ query: { v: 'FromQuery' }, url: '/ping?v=FromUrl' }),
      'FromQuery',
    );
  });

  test('raw-URL fallback percent-decodes (space, accent) and keeps the first repeat', () => {
    assert.equal(extractVaultParam({ url: '/ping?v=Vault%20%C3%89t%C3%A9' }), 'Vault Été');
    assert.equal(extractVaultParam({ url: '/ping?v=First&v=Second' }), 'First');
  });

  test('non-string garbage → null (mismatch, not a crash)', () => {
    assert.equal(extractVaultParam({ query: { v: { nested: 'object' } } }), null);
    assert.equal(extractVaultParam({ query: { v: 42 } }), null);
  });
});

describe('OPTIONS /ping', () => {
  test('204, ended, no body, with the four headers', () => {
    const res = mockRes();
    handlePingOptions({ ip: '127.0.0.1' }, res);
    assert.equal(res.statusCode, 204);
    assert.equal(res.ended, true);
    assert.equal(res.jsonBody, undefined);
    assert.deepEqual(res.headers, CONTRACT_HEADERS);
  });

  test('non-loopback refused with 403', () => {
    const res = mockRes();
    handlePingOptions({ ip: '10.0.0.5' }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.ended, false);
  });
});

describe('isLoopbackRequest', () => {
  test('loopback variants accepted', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '', undefined]) {
      assert.equal(isLoopbackRequest({ ip }), true, `ip=${String(ip)}`);
    }
  });

  test('null/undefined req tolerated', () => {
    assert.equal(isLoopbackRequest(null), true);
    assert.equal(isLoopbackRequest(undefined), true);
  });

  test('non-loopback refused', () => {
    for (const ip of ['192.168.0.11', '10.1.2.3', '8.8.8.8', '::ffff:192.168.1.1']) {
      assert.equal(isLoopbackRequest({ ip }), false, `ip=${ip}`);
    }
  });
});
