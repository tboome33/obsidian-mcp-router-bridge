/**
 * Shared types for the route handlers.
 */

/**
 * Request body for POST /search/smart.
 *
 * The original MCP Tools handler accepts the body either as a real JSON object
 * (when sent with Content-Type: application/json) OR as a JSON string in
 * text/plain — the obsidian-mcp-router router currently uses the text/plain
 * variant. We accept both for compatibility.
 */
export interface SearchSmartRequest {
  query: string;
  filter?: {
    folders?: string[];
    excludeFolders?: string[];
    limit?: number;
  };
}

export interface SearchSmartResultEntry {
  path: string;
  text: string;
  score: number;
  breadcrumbs?: string;
}

export interface SearchSmartResponse {
  results: SearchSmartResultEntry[];
}

/**
 * Request body for POST /templates/execute.
 *
 * Templater plugin must be enabled in the vault. The arguments map is exposed
 * inside the rendered template via `tp.mcpTools.prompt("key")` — kept named
 * `mcpTools` for backward compatibility with the original MCP Tools plugin and
 * any templates already using that accessor.
 */
export interface TemplateExecuteRequest {
  name: string;
  arguments?: Record<string, string>;
  createFile?: boolean;
  targetPath?: string;
}

export interface TemplateExecuteResponse {
  message: string;
  content: string;
  /**
   * Set when the rendered template was written to a new file. Reflects
   * the actual path Templater used (which may differ from the requested
   * `targetPath` if there was a name collision and Templater chose an
   * available variant).
   */
  path?: string;
}

/**
 * Public manifest exposed to GET / via the Local REST API plugin's apiExtensions
 * mechanism.
 */
export interface ApiExtensionInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
}
