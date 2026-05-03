import { TFile, type App } from 'obsidian';
import type { TemplateExecuteRequest, TemplateExecuteResponse } from '../types';

/**
 * Templater plugin API surface, derived from
 * https://github.com/SilentVoid13/Templater (see also MCP Tools'
 * packages/shared/src/types/plugin-templater.ts).
 *
 * RunMode 0 = CreateNewFromTemplate (the enum order has been stable
 * across all Templater versions; we hardcode to avoid pulling Templater
 * as a dependency).
 */
interface TemplaterApi {
  create_running_config: (
    template: TFile | undefined,
    target: TFile,
    runMode: number,
  ) => unknown;
  read_and_parse_template: (config: unknown) => Promise<string>;
  functions_generator: {
    generate_object: (...args: unknown[]) => Promise<Record<string, unknown>>;
  };
}

interface TemplaterPlugin {
  templater?: TemplaterApi;
}

const RUN_MODE_CREATE_NEW_FROM_TEMPLATE = 0;

/**
 * Module-level mutex for the Templater render path.
 *
 * The render flow monkey-patches Templater's *shared*
 * functions_generator.generate_object to inject `tp.mcpTools.prompt(...)`
 * for the duration of one call. Two concurrent /templates/execute
 * requests would step on each other:
 *   - Request B's patch overwrites request A's while A is still rendering.
 *   - Request A's restore could undo B's patch mid-flight.
 *   - Either render then sees the wrong `arguments` map.
 *
 * Serializing every render through this Promise-chain keeps each one
 * exclusive. Trade-off: concurrent requests queue behind each other —
 * acceptable because renders are sub-second on a personal vault.
 *
 * The original MCP Tools v0.2.31 plugin had the same race window but
 * never hit it in practice (single user, sequential MCP calls). We add
 * the mutex defensively.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

function withRenderLock<T>(task: () => Promise<T>): Promise<T> {
  const myTurn = renderQueue.then(() => task());
  // The queue itself never rejects, so a failed render doesn't poison
  // subsequent requests.
  renderQueue = myTurn.then(
    () => undefined,
    () => undefined,
  );
  return myTurn;
}

/**
 * POST /templates/execute
 *
 * Body (real JSON object, application/json):
 *   {
 *     "name": "Templates/Daily.md",
 *     "arguments": { "title": "..." },
 *     "createFile": true,
 *     "targetPath": "Daily/2026-05-03.md"
 *   }
 *
 * Renders the template via Templater's API and optionally writes the
 * result to a new file. The `arguments` map is exposed inside the
 * template at `tp.mcpTools.prompt("key")` — name kept for backward
 * compatibility with templates authored against the original MCP Tools
 * plugin.
 *
 * Implementation matches MCP Tools v0.2.31 handleTemplateExecution:
 *   1. Build a running config with template_file = target_file =
 *      the requested template. (Yes, both — that's what MCP Tools does.
 *      tp.file.* references will operate on the template note. For
 *      preview-only renders this is fine; for createFile renders the
 *      side-effect is that tp.file.path returns the template path. If
 *      a template uses tp.file.move/rename, it operates on the
 *      template — this is a known caveat documented in the README.)
 *   2. Patch generate_object to inject mcpTools.prompt.
 *   3. Render via read_and_parse_template (no side effect on disk).
 *   4. Restore generate_object.
 *   5. If createFile: app.vault.create(targetPath, content).
 */
export function makeTemplatesExecuteHandler(app: App) {
  return async function handleTemplatesExecute(req: any, res: any): Promise<void> {
    try {
      const tp = (app as any).plugins?.plugins?.['templater-obsidian'] as
        | TemplaterPlugin
        | undefined;
      const tplApi = tp?.templater;
      if (!tplApi) {
        res.status(503).json({
          error: 'Templater plugin is not available',
          hint: 'Install and enable Templater (templater-obsidian) in this vault.',
        });
        return;
      }

      const body = req.body as TemplateExecuteRequest | undefined;
      const validation = validateBody(body);
      if (validation) {
        res.status(validation.status).json(validation.payload);
        return;
      }

      const templateFile = app.vault.getAbstractFileByPath(body!.name);
      if (!(templateFile instanceof TFile)) {
        res.status(404).json({ error: `File not found: ${body!.name}` });
        return;
      }

      // Refuse to overwrite an existing target — protects user data when
      // they reuse a path that already exists. Note: `createFile === true`
      // (strict) — anything else means preview mode.
      if (body!.createFile === true && body!.targetPath) {
        const existing = app.vault.getAbstractFileByPath(body!.targetPath);
        if (existing) {
          res.status(409).json({
            error: 'Target path already exists',
            summary: `${body!.targetPath} already exists; pick a different targetPath or delete it first`,
          });
          return;
        }
      }

      const result = await withRenderLock(() =>
        renderAndOptionallyCreate(app, tplApi, templateFile, body!),
      );

      res.json(result);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[mcp-router-bridge] /templates/execute failed:', err);
      res.status(503).json({
        error: 'An error occurred while processing the prompt',
      });
    }
  };
}

function validateBody(
  body: TemplateExecuteRequest | undefined,
): { status: number; payload: Record<string, unknown> } | undefined {
  if (!body || typeof body !== 'object') {
    return {
      status: 400,
      payload: {
        error: 'Invalid request body',
        summary: 'expected a JSON object',
        body,
      },
    };
  }
  if (typeof body.name !== 'string' || body.name.length === 0) {
    return {
      status: 400,
      payload: {
        error: 'Invalid request body',
        summary: '`name` is required and must be a non-empty string',
      },
    };
  }
  // createFile MUST be a boolean when provided. We do a strict-type
  // check rather than a truthiness check because callers occasionally
  // serialize booleans as strings (e.g. "false"), which would be
  // truthy in JavaScript and silently create the file.
  if (body.createFile !== undefined && typeof body.createFile !== 'boolean') {
    return {
      status: 400,
      payload: {
        error: 'Invalid request body',
        summary: '`createFile` must be a boolean',
        receivedType: typeof body.createFile,
      },
    };
  }
  if (
    body.createFile === true &&
    (typeof body.targetPath !== 'string' || body.targetPath.length === 0)
  ) {
    return {
      status: 400,
      payload: {
        error: 'Invalid request body',
        summary: '`targetPath` is required when `createFile` is true',
      },
    };
  }
  return undefined;
}

/**
 * Patch generate_object, render the template, restore generate_object,
 * and optionally write the result to a new file. Caller must hold the
 * render mutex.
 */
async function renderAndOptionallyCreate(
  app: App,
  tplApi: TemplaterApi,
  templateFile: TFile,
  body: TemplateExecuteRequest,
): Promise<TemplateExecuteResponse> {
  const args = body.arguments ?? {};
  const promptFn = (key: string): string => {
    const value = args[key];
    return value == null ? '' : String(value);
  };

  const original = tplApi.functions_generator.generate_object.bind(
    tplApi.functions_generator,
  );
  tplApi.functions_generator.generate_object = async function patched(...callArgs: unknown[]) {
    const obj = await original(...callArgs);
    return Object.assign(obj, { mcpTools: { prompt: promptFn } });
  };

  let content: string;
  try {
    const config = tplApi.create_running_config(
      templateFile,
      templateFile,
      RUN_MODE_CREATE_NEW_FROM_TEMPLATE,
    );
    content = await tplApi.read_and_parse_template(config);
  } finally {
    // Always restore, even on render error, so we don't leak our patch
    // into Templater's normal Obsidian-UI usage.
    tplApi.functions_generator.generate_object = original;
  }

  if (body.createFile === true && body.targetPath) {
    const created = await app.vault.create(body.targetPath, content);
    return {
      message: 'Prompt executed and file created successfully',
      content,
      path: created.path,
    };
  }

  return {
    message: 'Prompt executed without creating a file',
    content,
  };
}
