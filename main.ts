import { Plugin, type PluginManifest } from 'obsidian';
import { makeSearchSmartHandler } from './src/handlers/search-smart';
import { makeTemplatesExecuteHandler } from './src/handlers/templates-execute';

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
}

interface LocalRestApiPublicApi {
  addRoute: (path: string) => LocalRestApiRouteBuilder;
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
 *
 * Drop-in replacement for the same routes in the now-unmaintained
 * jacksteamdev/obsidian-mcp-tools plugin, but without the bundled MCP
 * server binary (no native executable, no telemetry).
 *
 * Companion to obsidian-mcp-router. The route paths and request/response
 * schemas mirror MCP Tools v0.2.31 exactly so existing clients (the router
 * in particular) keep working without changes.
 */
export default class McpRouterBridgePlugin extends Plugin {
  /**
   * The scoped Local REST API public-api instance used to register our
   * routes. Stored so we can call .unregister() on unload, which removes
   * our handlers cleanly even on hot reload.
   */
  private restPublicApi: LocalRestApiPublicApi | undefined;

  /** Names of routes we registered. Used purely for logging on unload. */
  private registeredPaths: string[] = [];

  async onload(): Promise<void> {
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
