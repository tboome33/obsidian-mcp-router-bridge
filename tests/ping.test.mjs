/**
 * Tests for the /ping handlers in src/handlers/ping.mjs — the smart-link
 * resolver's local-mirror probe. Asserts the shared contract VERBATIM:
 * GET → 200 {"pong":true}, OPTIONS → 204 no body, both carrying the four
 * CORS/PNA headers, plus the loopback guard mirrored from /open.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PING_HEADERS,
  handlePingGet,
  handlePingOptions,
  isLoopbackRequest,
} from '../src/handlers/ping.mjs';

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
