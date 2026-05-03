/**
 * Bumps the plugin version. Run automatically by `npm version <type>`
 * via the `version` script in package.json, OR manually via
 * `node version-bump.mjs`.
 *
 * Reads the new version from `npm_package_version` (set by `npm version`),
 * writes it into `manifest.json`, and appends an entry to `versions.json`
 * mapping the new version → the current `minAppVersion`. Both files are
 * what Obsidian's marketplace needs.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
  console.error(
    'version-bump.mjs: npm_package_version is not set. Run via `npm version <patch|minor|major>` instead of invoking the script directly.',
  );
  process.exit(1);
}

// 1. Update manifest.json with the new version (preserve minAppVersion).
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

// 2. Append the new version → minAppVersion mapping to versions.json.
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');

console.log(
  `version-bump.mjs: bumped to ${targetVersion} (minAppVersion ${minAppVersion}).`,
);
