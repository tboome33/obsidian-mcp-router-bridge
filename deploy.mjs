#!/usr/bin/env node
/**
 * deploy.mjs
 *
 * Deploys the built bridge plugin (main.js + manifest.json) to the
 * reference vault (`.template`), which is the source `setup-vault.mjs`
 * (in the obsidian-mcp-router repo) clones from when bootstrapping or
 * --sync-plugins-ing other vaults.
 *
 * Run after `npm run build`. To propagate the new build to vaults
 * that already have the plugin installed:
 *
 *   1. Run this script (deploys to .template)
 *   2. Run setup-vault.mjs --sync-plugins --force <vault> on each
 *      consumer vault (re-clones plugins, preserves data.json)
 *   3. Disable+re-enable the plugin in each Obsidian vault, OR run the
 *      "Reload app without saving" command from the palette
 *
 * Resolves the .template path in this order:
 *   1. OBSIDIAN_TEMPLATE_VAULT env var (override)
 *   2. ~/.claude/obsidian-mcp-router/config.json `referenceVault` field
 *   3. error out with instructions
 *
 * The router-config dependency is pragmatic: anyone running this bridge
 * alongside the router has that file already. If you're using the bridge
 * standalone, set OBSIDIAN_TEMPLATE_VAULT and skip the router check.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const dstDir = path.join(pluginsDir, 'obsidian-mcp-router-bridge');
fs.mkdirSync(dstDir, { recursive: true });

// 4. Copy main.js + manifest.json (overwrite always — we just rebuilt)
fs.copyFileSync(MAIN_JS, path.join(dstDir, 'main.js'));
fs.copyFileSync(MANIFEST, path.join(dstDir, 'manifest.json'));

const mainSize = fs.statSync(MAIN_JS).size;
ok(`Deployed obsidian-mcp-router-bridge to ${dstDir}`);
info(`main.js: ${mainSize} bytes`);

// 5. Tell the user what's next
console.log('');
info('Next steps:');
console.log('  1. Propagate to other vaults that already have the plugin installed:');
console.log(`     node "<router-repo>/scripts/setup-vault.mjs" "<vault>" --sync-plugins --force`);
console.log('  2. In each Obsidian instance: disable+re-enable the plugin,');
console.log('     OR run the "Reload app without saving" command from the palette.');
