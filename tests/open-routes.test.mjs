/**
 * Tests for src/handlers/open-routes.mjs — where the public click-to-open
 * route gets registered, and which prefix the bridge announces.
 *
 * The heart of this file is a fake `addPublicRoute` that reproduces Local REST
 * API 5.4.0's rule VERBATIM (constants.ts BUILT_IN_ROUTE_PREFIXES + the
 * first-segment checks in publicApi.ts). Under 5.4.0, `/open/*` throws, and
 * before 0.10.0 that throw was only logged: GET /open/<path> then fell through
 * to the native, authenticated `/open/*` route and every click-to-open link
 * answered 401 (errorCode 40101).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OPEN_ROUTE_BASES,
  PRIMARY_OPEN_PREFIX,
  LEGACY_OPEN_PREFIX,
  registerOpenRoutes,
} from '../src/handlers/open-routes.mjs';

/** Local REST API 5.4.0, src/constants.ts. */
const LRA_540_RESERVED = ['vault', 'active', 'search', 'commands', 'events', 'mcp', 'open', 'tags'];
const LRA_540_BUILT_IN_ROUTES = ['/', '/openapi.yaml', '/openapi.json', '/obsidian-local-rest-api.crt'];

/**
 * Fake public API. `rules: '5.4.0'` applies the reserved-prefix check exactly
 * as 5.4.0's addPublicRoute does; `rules: '4.x'` accepts every path, as 4.0.2
 * does. Records what got registered and with which GET handler.
 */
function fakeApi(rules) {
  const routes = new Map();
  return {
    routes,
    addPublicRoute(path) {
      if (rules === '5.4.0') {
        const normalize = (p) => p.toLowerCase().replace(/\/+$/, '');
        if (LRA_540_BUILT_IN_ROUTES.map(normalize).includes(normalize(path))) {
          throw new Error(`Cannot register a public route at "${path}" — this path is reserved by Obsidian Local REST API.`);
        }
        const firstSegment = path.replace(/^\//, '').split('/')[0];
        if (/[:*?()+[\]{}|\\^$]/.test(firstSegment)) {
          throw new Error(`Cannot register a public route at "${path}" — its first segment "${firstSegment}" is a pattern.`);
        }
        const prefix = firstSegment.toLowerCase();
        if (LRA_540_RESERVED.includes(prefix)) {
          throw new Error(`Cannot register a public route at "${path}" — paths under "/${prefix}/" are reserved by Obsidian Local REST API.`);
        }
      }
      return {
        get(handler) {
          routes.set(path, handler);
        },
      };
    },
  };
}

const handler = () => {};

describe('open route constants', () => {
  test('primary prefix starts with the plugin id, legacy prefix is /open/', () => {
    assert.equal(PRIMARY_OPEN_PREFIX, '/mcp-router-bridge/open/');
    assert.equal(LEGACY_OPEN_PREFIX, '/open/');
    assert.deepEqual([...OPEN_ROUTE_BASES], ['/mcp-router-bridge/open', '/open']);
  });

  test("the primary prefix's first segment is not reserved by Local REST API 5.4.0", () => {
    const first = PRIMARY_OPEN_PREFIX.split('/')[1];
    assert.ok(!LRA_540_RESERVED.includes(first));
  });
});

describe('registerOpenRoutes — Local REST API 5.4.0 (reserved prefixes)', () => {
  test('registers the plugin-id route, announces it, and reports /open/* as refused', () => {
    const api = fakeApi('5.4.0');
    const result = registerOpenRoutes(api.addPublicRoute.bind(api), handler);
    assert.equal(result.openPrefix, '/mcp-router-bridge/open/');
    assert.deepEqual(result.registered, ['/mcp-router-bridge/open/*']);
    assert.equal(result.refused.length, 1);
    assert.equal(result.refused[0].path, '/open/*');
    assert.match(result.refused[0].message, /reserved by Obsidian Local REST API/);
    assert.equal(api.routes.get('/mcp-router-bridge/open/*'), handler);
    assert.ok(!api.routes.has('/open/*'));
  });

  test('never throws, even though one candidate does', () => {
    const api = fakeApi('5.4.0');
    assert.doesNotThrow(() => registerOpenRoutes(api.addPublicRoute.bind(api), handler));
  });
});

describe('registerOpenRoutes — Local REST API 4.x (no reserved prefixes)', () => {
  test('registers both routes and announces the plugin-id one', () => {
    const api = fakeApi('4.x');
    const result = registerOpenRoutes(api.addPublicRoute.bind(api), handler);
    assert.equal(result.openPrefix, '/mcp-router-bridge/open/');
    assert.deepEqual(result.registered, ['/mcp-router-bridge/open/*', '/open/*']);
    assert.deepEqual(result.refused, []);
    assert.equal(api.routes.get('/open/*'), handler);
  });
});

describe('registerOpenRoutes — degraded hosts', () => {
  test('a host that only accepts /open/* announces /open/', () => {
    const add = (path) => {
      if (path !== '/open/*') throw new Error('nope');
      return { get() {} };
    };
    const result = registerOpenRoutes(add, handler);
    assert.equal(result.openPrefix, '/open/');
    assert.deepEqual(result.registered, ['/open/*']);
    assert.equal(result.refused[0].path, '/mcp-router-bridge/open/*');
  });

  test('a host that refuses everything announces null', () => {
    const result = registerOpenRoutes(() => {
      throw new Error('nope');
    }, handler);
    assert.equal(result.openPrefix, null);
    assert.deepEqual(result.registered, []);
    assert.equal(result.refused.length, 2);
  });

  test('no addPublicRoute at all announces null and registers nothing', () => {
    const result = registerOpenRoutes(undefined, handler);
    assert.equal(result.openPrefix, null);
    assert.deepEqual(result.registered, []);
    assert.deepEqual(result.refused, []);
  });

  test('a non-Error throw is still reported as a string message', () => {
    const result = registerOpenRoutes(() => {
      throw 'plain string';
    }, handler);
    assert.equal(result.refused[0].message, 'plain string');
  });
});
