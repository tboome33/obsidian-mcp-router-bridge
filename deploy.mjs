#!/usr/bin/env node
/**
 * deploy.mjs
 *
 * Deploys the built bridge plugin (main.js + manifest.json) to the
 * reference vault (`.template`), which is the source `setup-vault.mjs`
 * (in the obsidian-mcp-router repo) clones from when bootstrapping or
 * --sync-plugins-ing other vaults.
 *
 * Auto-runs after every `npm run build` via the `postbuild` hook in
 * package.json. Manual invocation works too.
 *
 * Flags:
 *   --all   Also propagate from `.template` to every vault in the
 *           router's portRegistry by spawning
 *           `node <router>/scripts/setup-vault.mjs --sync-all --force`.
 *           Wired up as `npm run deploy:all`. Obsidian still needs a
 *           manual reload per running instance afterwards.
 *
 * Resolves the .template path in this order:
 *   1. OBSIDIAN_TEMPLATE_VAULT env var (override)
 *   2. ~/.claude/obsidian-mcp-router/config.json `referenceVault` field
 *   3. error out with instructions
 *
 * Resolves the router repo path (for --all) in this order:
 *   1. OBSIDIAN_ROUTER_REPO env var (override)
 *   2. sibling directory convention: <bridge>/../obsidian-mcp-router
 *   3. error out with instructions
 *
 * The router-config dependency is pragmatic: anyone running this bridge
 * alongside the router has that file already. If you're using the bridge
 * standalone, set OBSIDIAN_TEMPLATE_VAULT and skip the router check.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SELF_DIR = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]):/, '$1:'));
const MAIN_JS = path.join(SELF_DIR, 'main.js');
const MANIFEST = path.join(SELF_DIR, 'manifest.json');

function fail(msg) {
  console.error('\x1b[31m✗\x1b[0m ' + msg);
  process.exit(1);
}

function ok(msg) {
  console.log('\x1b[32m✓\x1b[0m ' + msg);
}

function info(msg) {
  console.log('\x1b[36mℹ\x1b[0m ' + msg);
}

// CI (GitHub Actions release build) has no local .template / router config to
// deploy to — the build there only needs to produce main.js for the release.
// `npm run build` runs this as a postbuild hook, so skip gracefully instead of
// fail()-ing on the missing config. GitHub Actions sets CI=true automatically.
if (process.env.CI) {
  info('CI detected — skipping .template deploy (release build only).');
  process.exit(0);
}

// 1. Verify the build is fresh
if (!fs.existsSync(MAIN_JS)) {
  fail(`main.js not found. Run \`npm run build\` first.`);
}
if (!fs.existsSync(MANIFEST)) {
  fail(`manifest.json not found. Are you in the bridge repo root?`);
}

// 2. Resolve target template vault
let templateVault = process.env.OBSIDIAN_TEMPLATE_VAULT;
if (!templateVault) {
  const routerConfigPath = path.join(
    os.homedir(),
    '.claude',
    'obsidian-mcp-router',
    'config.json',
  );
  if (!fs.existsSync(routerConfigPath)) {
    fail(
      `No template vault configured.\n  ` +
      `Set OBSIDIAN_TEMPLATE_VAULT=<absolute-path> or bootstrap a vault first via\n  ` +
      `obsidian-mcp-router's scripts/setup-vault.mjs --init-reference <path>`,
    );
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(routerConfigPath, 'utf8'));
  } catch (err) {
    fail(`Could not read router config at ${routerConfigPath}: ${err.message}`);
  }
  templateVault = cfg.referenceVault;
  if (!templateVault) {
    fail(
      `Router config exists but has no \`referenceVault\` field.\n  ` +
      `Run setup-vault.mjs --init-reference <path-to-template-vault> first.`,
    );
  }
}

if (!fs.existsSync(templateVault)) {
  fail(`Template vault path does not exist: ${templateVault}`);
}

// 3. Build target plugin folder path and verify the .obsidian dir is there
const pluginsDir = path.join(templateVault, '.obsidian', 'plugins');
if (!fs.existsSync(pluginsDir)) {
  fail(
    `Template vault has no .obsidian/plugins/ dir. Is this really an Obsidian vault?\n  ` +
    `Path: ${templateVault}`,
  );
}

// Plugin folder name MUST match `id` in manifest.json — Obsidian uses the id
// as the folder name in `.obsidian/plugins/<id>/`. Renamed in v0.1.1 to drop
// the "obsidian-" prefix per Obsidian community-plugin guidelines (the word
// "obsidian" is not allowed in plugin IDs because it's redundant context).
const PLUGIN_ID = 'mcp-router-bridge';
const LEGACY_PLUGIN_ID = 'obsidian-mcp-router-bridge';

// Cleanup: if a legacy folder from v0.1.0 (or earlier) exists, remove it so
// `setup-vault.mjs --sync-plugins --force` doesn't propagate the stale copy
// to bootstrapped vaults. Loud info log so the user knows we touched their
// reference vault. Safe: only removes the specific legacy plugin folder, not
// anything else under .obsidian/plugins/.
const legacyDir = path.join(pluginsDir, LEGACY_PLUGIN_ID);
if (fs.existsSync(legacyDir)) {
  fs.rmSync(legacyDir, { recursive: true, force: true });
  info(`Removed legacy plugin folder: ${legacyDir}`);
}

const dstDir = path.join(pluginsDir, PLUGIN_ID);
fs.mkdirSync(dstDir, { recursive: true });

// 4. Copy main.js + manifest.json (overwrite always — we just rebuilt)
fs.copyFileSync(MAIN_JS, path.join(dstDir, 'main.js'));
fs.copyFileSync(MANIFEST, path.join(dstDir, 'manifest.json'));

// Drop a `.hotreload` marker so pjeby's Hot Reload plugin (if installed in the
// consumer vault) watches this folder and live-reloads the bridge whenever
// main.js changes on disk — i.e. on every `deploy:all`, with no manual "Reload
// app without saving" per Obsidian instance. The marker propagates to consumer
// vaults via setup-vault.mjs's recursive plugin copy (fs.cpSync). Harmless if
// Hot Reload isn't installed. See the router's project-bridge "Hot Reload" note.
try {
  fs.writeFileSync(path.join(dstDir, '.hotreload'), '');
} catch (err) {
  // Non-fatal: main.js + manifest.json already copied; only the live-reload
  // convenience is lost. Warn loudly rather than crash the deploy with a stack.
  console.warn('\x1b[33m⚠\x1b[0m Could not write .hotreload marker (Hot Reload live-reload may not trigger): ' + err.message);
}

const mainSize = fs.statSync(MAIN_JS).size;
ok(`Deployed ${PLUGIN_ID} to ${dstDir}`);
info(`main.js: ${mainSize} bytes`);

// 5. Optional --all: propagate from .template to every vault in the router's
//    portRegistry. Skipped by default — postbuild only touches .template so dev
//    rebuilds stay fast; `npm run deploy:all` is the explicit "ship everywhere".
const args = process.argv.slice(2);
if (args.includes('--all')) {
  console.log('');
  info('--all: propagating to every vault in the router portRegistry…');

  let routerRepo = process.env.OBSIDIAN_ROUTER_REPO;
  if (!routerRepo) {
    routerRepo = path.resolve(SELF_DIR, '..', 'obsidian-mcp-router');
  }
  const setupScript = path.join(routerRepo, 'scripts', 'setup-vault.mjs');
  if (!fs.existsSync(setupScript)) {
    fail(
      `Cannot locate the router's setup-vault.mjs.\n  ` +
      `Looked at: ${setupScript}\n  ` +
      `Set OBSIDIAN_ROUTER_REPO=<absolute-path-to-router-repo> or place this bridge\n  ` +
      `repo as a sibling of obsidian-mcp-router/ (the default convention).`,
    );
  }

  info(`Router repo: ${routerRepo}`);
  const result = spawnSync(
    process.execPath,
    [setupScript, '--sync-all', '--force'],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    fail(`setup-vault.mjs --sync-all --force exited with code ${result.status}`);
  }

  console.log('');
  ok('All vaults synced from .template.');
  console.log('');
  info('Final step (manual): in each running Obsidian instance, either');
  console.log('  • Cmd/Ctrl+P → "Reload app without saving", OR');
  console.log('  • Settings → Community plugins → toggle MCP Router Bridge off/on');
} else {
  // 6. Hint at the next steps when --all wasn't passed
  console.log('');
  info('Next steps:');
  console.log('  • Propagate to every consumer vault in one shot:');
  console.log('      npm run deploy:all');
  console.log('    (or manually: node "<router-repo>/scripts/setup-vault.mjs" --sync-all --force)');
  console.log('  • Then in each Obsidian instance: disable+re-enable the plugin,');
  console.log('    OR run the "Reload app without saving" command from the palette.');
}
