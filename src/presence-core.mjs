/**
 * Pure helpers for the presence heartbeat (no Obsidian imports → directly
 * testable with node:test on every supported Node version — same rationale
 * as src/handlers/open-params.mjs).
 *
 * Presence files live at wiki-meta/presence/<deviceId>.json — a VISIBLE
 * path on purpose. This is load-bearing: Self-hosted LiveSync does NOT
 * replicate hidden (dot-prefixed) paths by default, and the whole point of
 * the file is to be replicated to the server-side vault copy so the
 * smart-link resolver can list active local mirrors. Do not move it into a
 * dot-folder.
 */

export const PRESENCE_DIR = 'wiki-meta/presence';

/** Heartbeat period. Resolver-side freshness TTL is 10 minutes (2 beats). */
export const PRESENCE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Sanitize a raw hostname into a [a-z0-9-] device id. Returns '' when
 * nothing survives (caller then falls back to a persisted random id).
 * @param {unknown} raw
 * @returns {string}
 */
export function sanitizeDeviceId(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/, '');
}

/**
 * Random fallback device id (8 chars, [a-z0-9]). Not a secret — just a
 * stable-ish filename — so Math.random is fine.
 * @param {number} [len]
 * @returns {string}
 */
export function randomDeviceId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

/**
 * Build the presence payload (shared contract with the resolver — key set
 * and meaning are fixed):
 *   { device, vaultName, insecurePort, lastSeen, bridgeVersion }
 * @param {{ device: string, vaultName: string, insecurePort: number,
 *           lastSeen: string, bridgeVersion: string }} fields
 * @returns {{ device: string, vaultName: string, insecurePort: number,
 *             lastSeen: string, bridgeVersion: string }}
 */
export function buildPresencePayload({ device, vaultName, insecurePort, lastSeen, bridgeVersion }) {
  return { device, vaultName, insecurePort, lastSeen, bridgeVersion };
}

/**
 * Vault-relative path of a device's presence file.
 * @param {string} deviceId
 * @returns {string}
 */
export function presenceFilePath(deviceId) {
  return `${PRESENCE_DIR}/${deviceId}.json`;
}
