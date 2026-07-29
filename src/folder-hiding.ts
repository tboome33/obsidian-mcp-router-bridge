import type McpRouterBridgePlugin from '../main';
import { HIDDEN_FOLDERS_STYLE_ID, buildHiddenFoldersCss } from './folder-hiding-core.mjs';

/**
 * Cosmetic file-explorer folder hiding.
 *
 * Owns a single `<style>` element in `document.head` whose content is
 * recomputed from the settings on demand. That is the entire mechanism: no
 * rename, no dot-prefix, no vault mutation, nothing the Local REST API can
 * observe — the MCP router keeps reading `wiki-meta` (hot / catalog / journal)
 * exactly as before. See src/folder-hiding-core.mjs for why a dot-folder was
 * ruled out and why the two CSS rules must stay in separate blocks.
 *
 * Settings live in the plugin's per-vault `data.json`, so hiding can be on in
 * one vault and off in another with no shared configuration.
 *
 * Failure posture matches the presence heartbeat: never crash the plugin. A
 * DOM operation that throws leaves the explorer as-is (folders visible), which
 * is the safe direction for a purely cosmetic feature.
 */
export class FolderHidingManager {
  private styleEl: HTMLStyleElement | null = null;

  constructor(private readonly plugin: McpRouterBridgePlugin) {}

  /**
   * Apply the current settings and register teardown. `register()` makes
   * Obsidian remove the stylesheet on plugin unload — without it a disabled
   * plugin would keep hiding folders until the app restarts.
   */
  start(): void {
    this.plugin.register(() => this.destroy());
    this.apply();
  }

  /**
   * Recompute and inject the stylesheet. Called at load and on every settings
   * change, which is what makes the setting take effect with no restart.
   */
  apply(): void {
    try {
      const css = buildHiddenFoldersCss(
        this.plugin.settings.hiddenFolders,
        this.plugin.settings.hideFoldersEnabled,
      );

      if (!css) {
        // Switched off, or an empty list: drop the element rather than leave an
        // empty <style> behind, so "off" is also invisible in the DOM.
        this.destroy();
        return;
      }

      if (!this.styleEl) {
        // Reap a stale element from a previous instance before adding ours.
        // Hot Reload (see deploy.mjs) swaps main.js in place, and an unload
        // that failed mid-way would otherwise leave a duplicate behind.
        document.getElementById(HIDDEN_FOLDERS_STYLE_ID)?.remove();
        const el = document.createElement('style');
        el.id = HIDDEN_FOLDERS_STYLE_ID;
        document.head.appendChild(el);
        this.styleEl = el;
      }

      this.styleEl.textContent = css;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] could not apply folder hiding CSS:', err);
    }
  }

  /** Remove the stylesheet. Idempotent. */
  destroy(): void {
    try {
      this.styleEl?.remove();
    } catch {
      /* the element is already detached — nothing to undo */
    }
    this.styleEl = null;
  }
}
