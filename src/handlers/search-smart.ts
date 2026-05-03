import type { App } from 'obsidian';
import type { SearchSmartRequest, SearchSmartResponse } from '../types';

/**
 * The Smart Search interface as exposed by Smart Connections. Matches
 * the shape MCP Tools' loadSmartSearchAPI uses (see
 * obsidian-mcp-tools/packages/obsidian-plugin/src/shared/index.ts).
 */
interface SmartSearch {
  search(
    text: string,
    filter?: Record<string, unknown>,
  ): Promise<SmartSearchMatch[]>;
}

interface SmartSearchMatch {
  item: {
    path: string;
    breadcrumbs?: string;
    read?: () => Promise<string>;
  };
  score: number;
}

/**
 * Smart Connections plugin instance. Modern (v3.0+) versions expose
 * `env.smart_sources.lookup` instead of a direct search. Older versions
 * expose either `window.SmartSearch` globally or `env` directly.
 */
interface SmartConnectionsPlugin {
  env?: {
    smart_sources?: {
      lookup?: (opts: {
        hypotheticals?: string[];
        filter?: Record<string, unknown>;
      }) => Promise<SmartSearchMatch[]>;
    };
    /**
     * On some Smart Connections versions, the env object itself
     * implements the SmartSearch interface (i.e. it has a .search method).
     * Used as a fallback after window.SmartSearch.
     */
    search?: SmartSearch['search'];
  };
}

/**
 * Window with optional SmartSearch global, set by Smart Connections v2.x.
 */
interface WindowWithSmartSearch extends Window {
  SmartSearch?: SmartSearch;
}

/**
 * POST /search/smart
 *
 * Body: SearchSmartRequest. The router serializes this to a JSON string
 * and sends it with text/plain Content-Type, matching the original MCP
 * Tools quirk. We accept either form.
 *
 * Resolves the Smart Connections search interface in this preference
 * order (matches MCP Tools v0.2.31 loadSmartSearchAPI):
 *   1. Smart Connections v3.0+: env.smart_sources.lookup → adapt to
 *      SmartSearch shape.
 *   2. window.SmartSearch (v2.x global, set by some platforms).
 *   3. plugin.env (some platforms expose the SmartSearch interface
 *      directly on env, used by MCP Tools as a Linux/cross-platform
 *      fallback).
 *
 * Returns 503 if none of the above is available.
 */
export function makeSearchSmartHandler(app: App) {
  return async function handleSearchSmart(req: any, res: any): Promise<void> {
    try {
      const search = resolveSearch(app);
      if (!search) {
        res.status(503).json({
          error: 'Smart Connections plugin is not available',
          hint:
            "Install and enable Smart Connections in this vault, and ensure it has finished indexing before calling /search/smart.",
        });
        return;
      }

      const parsed = parseBody(req.body);
      if ('error' in parsed) {
        res.status(400).json(parsed);
        return;
      }

      if (typeof parsed.query !== 'string' || parsed.query.length === 0) {
        res.status(400).json({
          error: 'Invalid request body',
          summary: '`query` is required and must be a non-empty string',
        });
        return;
      }

      // Translate the user-facing { folders, excludeFolders, limit } shape
      // into the Smart Connections internal filter keys, exactly as MCP
      // Tools does.
      const filter: Record<string, unknown> = {};
      if (parsed.filter?.folders) {
        filter.key_starts_with_any = parsed.filter.folders;
      }
      if (parsed.filter?.excludeFolders) {
        filter.exclude_key_starts_with_any = parsed.filter.excludeFolders;
      }
      if (typeof parsed.filter?.limit === 'number') {
        filter.limit = parsed.filter.limit;
      }

      const matches = await search(parsed.query, filter);

      const results = await Promise.all(
        matches.map(async (m) => ({
          path: m.item.path,
          text: typeof m.item.read === 'function' ? await m.item.read() : '',
          score: m.score,
          breadcrumbs: m.item.breadcrumbs ?? '',
        })),
      );

      const response: SearchSmartResponse = { results };
      res.json(response);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] /search/smart failed:', err);
      res.status(503).json({
        error: 'An error occurred while processing the search request',
      });
    }
  };
}

/**
 * Resolve a callable (text, filter) → matches function from the available
 * Smart Connections accessors. Returns undefined when none is reachable.
 */
function resolveSearch(
  app: App,
):
  | ((text: string, filter: Record<string, unknown>) => Promise<SmartSearchMatch[]>)
  | undefined {
  const sc = (app as any).plugins?.plugins?.['smart-connections'] as
    | SmartConnectionsPlugin
    | undefined;

  // 1. Smart Connections v3.0+ exposes env.smart_sources with a lookup
  //    method that takes { hypotheticals: [text], filter }.
  if (sc?.env?.smart_sources?.lookup) {
    const env = sc.env;
    const sources = env.smart_sources!;
    return async (text, filter) => {
      const matches = await sources.lookup!({
        hypotheticals: [text],
        filter,
      });
      // The v3.0 result shape may differ slightly; normalize to the
      // shared SmartSearchMatch interface that the response uses.
      return matches.map((m: any) => ({
        item: {
          path: m.item.path,
          breadcrumbs: m.item.breadcrumbs ?? m.item.path,
          read: typeof m.item.read === 'function' ? () => m.item.read() : undefined,
        },
        score: m.score,
      }));
    };
  }

  // 2. window.SmartSearch (v2.x). On some platforms, MCP Tools assigns
  //    sc.env to window.SmartSearch as a side effect; we don't, but we
  //    still check it for compatibility with installs that did set it.
  const w = window as WindowWithSmartSearch;
  if (w.SmartSearch && typeof w.SmartSearch.search === 'function') {
    const ss = w.SmartSearch;
    return (text, filter) => ss.search(text, filter);
  }

  // 3. Plugin.env directly implements SmartSearch on some Smart
  //    Connections versions (legacy fallback used by MCP Tools).
  if (sc?.env && typeof sc.env.search === 'function') {
    const env = sc.env;
    return (text, filter) => env.search!(text, filter);
  }

  return undefined;
}

/**
 * Parse the request body, accepting either a real JSON object or a
 * JSON-stringified payload in text/plain. Mirrors MCP Tools' use of
 * jsonSearchRequest = type("string.json.parse").to(searchRequest).
 */
function parseBody(
  body: unknown,
): SearchSmartRequest | { error: string; summary: string } {
  if (typeof body === 'string') {
    try {
      const obj = JSON.parse(body);
      if (typeof obj === 'object' && obj !== null) {
        return obj as SearchSmartRequest;
      }
      return { error: 'Invalid request body', summary: 'parsed value is not an object' };
    } catch {
      return {
        error: 'Invalid request body',
        summary: 'body must be a valid JSON object or stringified JSON',
      };
    }
  }
  if (typeof body === 'object' && body !== null) {
    return body as SearchSmartRequest;
  }
  return {
    error: 'Invalid request body',
    summary: 'body must be a JSON object or a JSON-stringified payload',
  };
}
