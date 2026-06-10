import { App, Plugin, PluginSettingTab, Setting, type PluginManifest } from 'obsidian';
import { makeSearchSmartHandler } from './src/handlers/search-smart';
import { makeTemplatesExecuteHandler } from './src/handlers/templates-execute';
import { makeOpenHandler } from './src/handlers/open';
import { handlePingGet, handlePingOptions } from './src/handlers/ping.mjs';
import { PresenceManager } from './src/presence';

/**
 * Local REST API public API surface (see
 * https://github.com/coddingtonbear/obsidian-local-rest-api/blob/main/src/api.ts).
 * Each instance is scoped to a calling plugin via getPublicApi(manifest)
 * so that unregister() removes only that plugin's routes.
 */
interface LocalRestApiRouteBuilder {
  get: (handler: any) => void;
  post: (handler: any) => void;
  put: (handler: any) => void;
  patch: (handler: any) => void;
  delete: (handler: any) => void;
  head: (handler: any) => void;
  /**
   * addRoute/addPublicRoute return an Express IRoute, which also exposes
   * .options(). Optional here because very old Local REST API builds might
   * not — we feature-detect before using it (/ping preflight).
   */
  options?: (handler: any) => void;
}

interface LocalRestApiPublicApi {
  addRoute: (path: string) => LocalRestApiRouteBuilder;
  /**
   * Register a route that bypasses Local REST API's Bearer-token check.
   * Used here for GET /open/* — see security analysis in
   * src/handlers/open.ts (scope = navigation-only, loopback-only,
   * no read/write access to content).
   */
  addPublicRoute?: (path: string) => LocalRestApiRouteBuilder;
  unregister: () => void;
}

/**
 * The obsidian-local-rest-api plugin instance shape. We call
 * getPublicApi(manifest) on it to get a scoped extension API. This is
 * exactly what the npm package's getAPI(app, manifest) does internally
 * (see obsidian-local-rest-api/src/main.ts: getAPI). Calling it directly
 * via the plugin instance avoids a runtime dependency on the npm package.
 */
interface LocalRestApiPlugin {
  getPublicApi?: (manifest: PluginManifest) => LocalRestApiPublicApi;
}

/**
 * obsidian-mcp-router-bridge
 *
 * A minimal Obsidian community plugin that registers two REST routes on the
 * Local REST API plugin (Adam Coddington), delegating to Smart Connections
 * (Brian Petro) and Templater (SilentVoid13):
 *
 *   POST /search/smart        → Smart Connections semantic search
 *   POST /templates/execute   → Templater template execution
 *   GET  /open/<path>         → Navigate Obsidian to a vault file
 *                                (loopback-only, no auth; for clickable
 *                                http links in chat/terminal contexts
 *                                where obsidian:// URIs aren't dispatched)
 *   GET  /ping                → Bare {"pong":true} probe for the smart-link
 *                                resolver's local-mirror detection
 *                                (loopback-only, no auth, no data)
 *
 * It also runs a presence heartbeat (src/presence.ts) that writes
 * wiki-meta/presence/<deviceId>.json every 5 minutes so a smart-link
 * resolver can list this device as an active local mirror (the file is
 * replicated server-side by LiveSync). Toggleable in settings, default ON.
 *
 * Self-contained: adds these routes on top of Local REST API without
 * bundling a native MCP server binary, telemetry, or any external network
 * calls. The actual MCP server lives in the companion obsidian-mcp-router
 * project, which talks to these routes over HTTPS.
 *
 * The route paths, request/response schemas, and `tp.mcpTools.prompt`
 * accessor are kept stable across versions so clients don't break when
 * this plugin is upgraded.
 */
export interface McpRouterBridgeSettings {
  /** Presence heartbeat for smart links (wiki-meta/presence/). Default ON. */
  presenceHeartbeat: boolean;
  /**
   * Random device id used when os.hostname() is unavailable/unusable.
   * Persisted so the same machine keeps the same presence file.
   */
  deviceIdFallback: string | null;
}

const DEFAULT_SETTINGS: McpRouterBridgeSettings = {
  presenceHeartbeat: true,
  deviceIdFallback: null,
};

export default class McpRouterBridgePlugin extends Plugin {
  /**
   * The scoped Local REST API public-api instance used to register our
   * routes. Stored so we can call .unregister() on unload, which removes
   * our handlers cleanly even on hot reload.
   */
  private restPublicApi: LocalRestApiPublicApi | undefined;

  /** Names of routes we registered. Used purely for logging on unload. */
  private registeredPaths: string[] = [];

  settings: McpRouterBridgeSettings = { ...DEFAULT_SETTINGS };

  presence: PresenceManager | undefined;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new McpRouterBridgeSettingTab(this.app, this));

    // Presence heartbeat: first beat at layout-ready (peer plugins loaded),
    // then every 5 minutes via registerInterval (cleared on unload).
    this.presence = new PresenceManager(this);
    this.presence.start();

    // Wait for layout-ready so all peer plugins (Local REST API, Smart
    // Connections, Templater) have a chance to load before we look them up.
    this.app.workspace.onLayoutReady(() => {
      this.registerRoutes();
    });

    // Also listen for the Local REST API "loaded" workspace event so we
    // attach our routes if Local REST API was enabled AFTER us, OR if it
    // was hot-reloaded (the previously-cached publicApi becomes stale —
    // we drop it and re-acquire fresh).
    this.registerEvent(
      // @ts-ignore — custom event emitted by obsidian-local-rest-api
      this.app.workspace.on('obsidian-local-rest-api:loaded', () => {
        this.restPublicApi = undefined;
        this.registeredPaths = [];
        this.registerRoutes();
      }),
    );
  }

  async onunload(): Promise<void> {
    if (this.restPublicApi && typeof this.restPublicApi.unregister === 'function') {
      try {
        this.restPublicApi.unregister();
        // eslint-disable-next-line no-console
        console.log(
          `[mcp-router-bridge] Unregistered ${this.registeredPaths.length} route(s) from Local REST API: ${this.registeredPaths.join(', ')}`,
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[mcp-router-bridge] Failed to unregister Local REST API extension:', err);
      }
    }
    this.restPublicApi = undefined;
    this.registeredPaths = [];
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private registerRoutes(): void {
    if (this.restPublicApi) {
      // Already registered.
      return;
    }

    const publicApi = this.acquireLocalRestApi();
    if (!publicApi) {
      // eslint-disable-next-line no-console
      console.warn(
        '[mcp-router-bridge] Local REST API plugin not loaded. Routes /search/smart and /templates/execute were NOT registered. We will retry automatically when obsidian-local-rest-api emits its loaded event.',
      );
      return;
    }

    this.restPublicApi = publicApi;

    const searchHandler = makeSearchSmartHandler(this.app);
    const templatesHandler = makeTemplatesExecuteHandler(this.app);
    const openHandler = makeOpenHandler(this.app);

    try {
      publicApi.addRoute('/search/smart').post(searchHandler);
      this.registeredPaths.push('/search/smart');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] Failed to register /search/smart:', err);
    }

    try {
      publicApi.addRoute('/templates/execute').post(templatesHandler);
      this.registeredPaths.push('/templates/execute');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] Failed to register /templates/execute:', err);
    }

    try {
      // Express 4 wildcard: '/open/*' matches anything under /open/, with
      // the matched portion in req.params[0]. See src/handlers/open.ts
      // for the security analysis (loopback-only, path traversal guards,
      // navigation-scope, justified no-auth).
      //
      // We use addPublicRoute (not addRoute) so Local REST API skips its
      // Bearer-token check for this endpoint. A click navigation from a
      // browser cannot attach an Authorization header, and embedding the
      // API key into the URL would expose it in browser history and
      // clipboard — so unauth here is mandatory, not a convenience. The
      // scope is intentionally minimal (navigation only, no content read,
      // no write, no execution) to keep the trust surface small.
      if (typeof publicApi.addPublicRoute !== 'function') {
        console.warn(
          '[mcp-router-bridge] Local REST API does not expose addPublicRoute() — skipping /open/* and /ping registration. Upgrade obsidian-local-rest-api to a version that supports public (auth-less) routes.',
        );
      } else {
        publicApi.addPublicRoute('/open/*').get(openHandler);
        this.registeredPaths.push('/open/* (public, no-auth)');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] Failed to register /open/*:', err);
    }

    try {
      // /ping: the smart-link resolver's local-mirror probe. Public for the
      // same reason as /open — a cross-origin fetch from the resolver page
      // can't attach an Authorization header. The handler returns a bare
      // {"pong":true} with CORS/PNA headers; see src/handlers/ping.mjs for
      // the contract and the OPTIONS-shadowing caveat.
      if (typeof publicApi.addPublicRoute === 'function') {
        const pingRoute = publicApi.addPublicRoute('/ping');
        pingRoute.get(handlePingGet);
        if (typeof pingRoute.options === 'function') {
          pingRoute.options(handlePingOptions);
        }
        this.registeredPaths.push('/ping (public, no-auth)');
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] Failed to register /ping:', err);
    }

    if (this.registeredPaths.length) {
      // eslint-disable-next-line no-console
      console.log(
        `[mcp-router-bridge] Registered ${this.registeredPaths.length} route(s): ${this.registeredPaths.join(', ')}`,
      );
    }
  }

  /**
   * Get the Local REST API plugin's manifest-scoped public API. Calls
   * `plugin.getPublicApi(this.manifest)` — same path used by the npm
   * package's exported `getAPI(app, manifest)` helper internally.
   * Returns undefined if Local REST API isn't loaded or doesn't expose
   * the expected method (e.g. very old version).
   */
  private acquireLocalRestApi(): LocalRestApiPublicApi | undefined {
    // Accessing internal plugins map via `as any` because Obsidian's
    // typings don't expose `app.plugins.plugins` publicly.
    const restApi = (this.app as any).plugins?.plugins?.['obsidian-local-rest-api'] as
      | LocalRestApiPlugin
      | undefined;

    if (!restApi || typeof restApi.getPublicApi !== 'function') {
      return undefined;
    }

    try {
      return restApi.getPublicApi(this.manifest);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] getPublicApi(manifest) threw:', err);
      return undefined;
    }
  }
}

class McpRouterBridgeSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly bridgePlugin: McpRouterBridgePlugin,
  ) {
    super(app, bridgePlugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Presence heartbeat (smart links)')
      .setDesc(
        'Write wiki-meta/presence/<device>.json every 5 minutes so smart-link resolvers can detect this device as an active local mirror.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.bridgePlugin.settings.presenceHeartbeat).onChange(async (value) => {
          this.bridgePlugin.settings.presenceHeartbeat = value;
          await this.bridgePlugin.saveSettings();
          // Re-enabling: beat right away instead of waiting up to 5 minutes.
          if (value) void this.bridgePlugin.presence?.beat();
        }),
      );
  }
}
