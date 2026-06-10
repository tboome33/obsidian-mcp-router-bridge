import type McpRouterBridgePlugin from '../main';
import {
  PRESENCE_DIR,
  PRESENCE_INTERVAL_MS,
  buildPresencePayload,
  presenceFilePath,
  randomDeviceId,
  sanitizeDeviceId,
} from './presence-core.mjs';

/**
 * Local REST API plugin instance, narrowed to the settings fields the
 * heartbeat needs. `settings` is a public field on that plugin's main
 * class; we read it via the plugins map to avoid a hard dependency.
 */
interface LocalRestApiSettingsView {
  settings?: {
    insecurePort?: unknown;
    enableInsecureServer?: unknown;
  };
}

/**
 * Presence heartbeat for the smart-link resolver.
 *
 * Writes wiki-meta/presence/<deviceId>.json — a VISIBLE path on purpose:
 * Self-hosted LiveSync does not replicate hidden (dot-prefixed) paths by
 * default, and the file only matters once replicated to the server-side
 * vault copy where the resolver reads it. The resolver treats a presence as
 * fresh for 10 minutes; we beat on layout-ready + every 5 minutes, so a
 * live mirror always has a fresh entry and a powered-off one expires after
 * at most two missed beats.
 *
 * Failure posture: never crash the plugin. Missing insecurePort or a failed
 * adapter write (read-only vault, sync lock) → skip this beat, log once,
 * retry next tick.
 */
export class PresenceManager {
  private deviceId: string | null = null;

  /** Log-once flags, reset on the next success so a regression re-logs. */
  private warnedNoPort = false;
  private warnedWriteFailure = false;
  private warnedInsecureServerOff = false;

  constructor(private readonly plugin: McpRouterBridgePlugin) {}

  /**
   * Schedule the heartbeat: one beat when the layout is ready (peer plugins
   * loaded → insecurePort readable) + every 5 minutes. The interval goes
   * through registerInterval so Obsidian clears it on plugin unload.
   */
  start(): void {
    this.plugin.app.workspace.onLayoutReady(() => {
      void this.beat();
    });
    this.plugin.registerInterval(
      window.setInterval(() => {
        void this.beat();
      }, PRESENCE_INTERVAL_MS),
    );
  }

  /** One heartbeat tick. Public so the settings toggle can beat immediately. */
  async beat(): Promise<void> {
    if (!this.plugin.settings.presenceHeartbeat) return;
    try {
      const insecurePort = await this.resolveInsecurePort();
      if (insecurePort === undefined) {
        if (!this.warnedNoPort) {
          this.warnedNoPort = true;
          // eslint-disable-next-line no-console
          console.warn(
            '[mcp-router-bridge] presence heartbeat skipped: could not determine the Local REST API insecurePort (plugin not loaded and its data.json unreadable). Retrying every 5 minutes.',
          );
        }
        return;
      }
      this.warnedNoPort = false;

      const device = await this.getDeviceId();
      const payload = buildPresencePayload({
        device,
        vaultName: this.plugin.app.vault.getName(),
        insecurePort,
        lastSeen: new Date().toISOString(),
        bridgeVersion: this.plugin.manifest.version,
      });

      const adapter = this.plugin.app.vault.adapter;
      // adapter.mkdir is not guaranteed recursive across adapters — create
      // each level explicitly. PRESENCE_DIR = 'wiki-meta/presence'.
      const parent = PRESENCE_DIR.split('/')[0];
      if (!(await adapter.exists(PRESENCE_DIR))) {
        if (!(await adapter.exists(parent))) await adapter.mkdir(parent);
        await adapter.mkdir(PRESENCE_DIR);
      }
      await adapter.write(presenceFilePath(device), JSON.stringify(payload, null, 2) + '\n');
      this.warnedWriteFailure = false;
    } catch (err) {
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        // eslint-disable-next-line no-console
        console.warn(
          '[mcp-router-bridge] presence heartbeat write failed (read-only vault?). Retrying every 5 minutes.',
          err,
        );
      }
    }
  }

  /**
   * Device id = sanitized os.hostname() (Electron desktop has Node's os
   * module), falling back to a random 8-char id persisted in the plugin's
   * saved data so the same machine keeps the same presence file across
   * restarts.
   */
  private async getDeviceId(): Promise<string> {
    if (this.deviceId) return this.deviceId;

    let id = sanitizeDeviceId(this.hostnameSafe());
    if (!id) {
      // Re-sanitize the persisted fallback too: the plugin only ever writes
      // [a-z0-9]{8}, but a hand-edited / sync-poisoned data.json could carry
      // path segments ("../../x") that would otherwise reach the adapter
      // write path verbatim. (Review finding, 2026-06-10.)
      id = sanitizeDeviceId(this.plugin.settings.deviceIdFallback ?? '');
      if (!id) {
        id = randomDeviceId();
        this.plugin.settings.deviceIdFallback = id;
        await this.plugin.saveSettings();
      }
    }
    this.deviceId = id;
    return id;
  }

  private hostnameSafe(): string {
    try {
      // Desktop Obsidian (Electron renderer, nodeIntegration) exposes
      // require(); 'os' is external in the esbuild config. Wrapped so an
      // exotic runtime degrades to the persisted fallback id, never a crash.
      const os = require('os') as typeof import('os');
      return typeof os.hostname === 'function' ? os.hostname() : '';
    } catch {
      return '';
    }
  }

  /**
   * insecurePort, in preference order:
   *   1. Local REST API plugin instance's live `settings.insecurePort`.
   *   2. Its data.json read via the vault adapter (plugin installed but not
   *      yet loaded when we beat).
   * undefined → the caller skips this beat (logged once).
   */
  private async resolveInsecurePort(): Promise<number | undefined> {
    const restApi = (this.plugin.app as any).plugins?.plugins?.['obsidian-local-rest-api'] as
      | LocalRestApiSettingsView
      | undefined;

    let port: unknown = restApi?.settings?.insecurePort;
    let insecureEnabled: unknown = restApi?.settings?.enableInsecureServer;

    if (typeof port !== 'number') {
      try {
        const adapter = this.plugin.app.vault.adapter;
        const dataPath = `${this.plugin.app.vault.configDir}/plugins/obsidian-local-rest-api/data.json`;
        if (await adapter.exists(dataPath)) {
          const parsed = JSON.parse(await adapter.read(dataPath)) as Record<string, unknown>;
          port = parsed.insecurePort;
          insecureEnabled = parsed.enableInsecureServer;
        }
      } catch {
        /* fall through → undefined */
      }
    }

    if (typeof port !== 'number' || !Number.isFinite(port)) return undefined;

    // Presence is still written when the insecure (HTTP) server is off —
    // the resolver's probe just fails and its cascade falls back — but warn
    // once so the user knows the advertised port is not actually probeable.
    if (insecureEnabled === false && !this.warnedInsecureServerOff) {
      this.warnedInsecureServerOff = true;
      // eslint-disable-next-line no-console
      console.warn(
        '[mcp-router-bridge] presence heartbeat: Local REST API insecure (HTTP) server is disabled — smart-link probes to /ping will fail on this device until enableInsecureServer is turned on.',
      );
    }

    return port;
  }
}
