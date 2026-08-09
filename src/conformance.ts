import { Notice, TFile } from 'obsidian';
import type McpRouterBridgePlugin from '../main';
import { runOpenCheck, statusLineForReport } from './conformance-core.mjs';

/** The shape src/conformance-core.mjs returns, plus the adapter's failure state. */
export interface ConformanceReport {
  status?: 'not-managed' | 'conformant' | 'incomplete';
  missing?: string[];
  unmarked?: string[];
  unreadable?: string[];
  contentPages?: number;
  expected?: number;
  searchIndexPresent?: boolean;
  /** Set by this adapter when the check itself could not run. */
  failed?: boolean;
  error?: string;
}

/** How long the Notice stays up. Long enough to read a path list. */
const NOTICE_MS = 12000;

/**
 * Open-time conformance check — the Obsidian side of src/conformance-core.mjs.
 *
 * This class is deliberately thin: it binds four effects (list the vault's
 * markdown files, read a file, probe a non-markdown file, show a Notice) to a
 * core that has no Obsidian import and is therefore testable with `node --test`.
 * Every rule lives there.
 *
 * DETECTION ONLY. Nothing in this file writes: no `adapter.write`, no
 * `vault.create`, no `vault.modify`. The projection generator has exactly one
 * implementation and it is in the router — see the core's header for why a
 * TypeScript port would be a bug rather than a convenience.
 *
 * DEFAULT OFF, and that is not timidity. This plugin auto-updates through BRAT,
 * so a behaviour that appeared by itself in every existing vault after an
 * upgrade would be an unannounced UI change — the same reasoning that keeps the
 * folder-hiding switch off. Opt in per vault.
 *
 * Runs ONCE, at layout-ready: the file index is populated by then, and repeating
 * the check on every file event would turn a useful signal into Notice spam. The
 * settings tab offers an explicit re-check for when you have just fixed
 * something.
 *
 * Failure posture matches the presence heartbeat: never crash the plugin, and
 * never let a failure masquerade as a clean bill of health. A check that threw
 * is recorded as `failed` — a state distinct from both "conformant" and "not
 * managed" — logged to the console ONCE, and never turned into a Notice.
 */
export class ConformanceManager {
  /** The last report, rendered by the settings tab. Null until the check runs. */
  lastReport: ConformanceReport | null = null;

  /** Log-once flag, reset on the next success so a regression re-logs. */
  private warnedCheckFailed = false;

  constructor(private readonly plugin: McpRouterBridgePlugin) {}

  start(): void {
    this.plugin.app.workspace.onLayoutReady(() => {
      void this.check();
    });
  }

  /** One check pass. Public so the settings toggle and the re-check button use it. */
  async check(): Promise<ConformanceReport | null> {
    try {
      const report = (await runOpenCheck({
        enabled: this.plugin.settings.conformanceCheckEnabled,
        listMarkdownPaths: () => this.plugin.app.vault.getMarkdownFiles().map((f: TFile) => f.path),
        readFile: (path: string) => this.readOrNull(path),
        fileExists: (path: string) => this.plugin.app.vault.adapter.exists(path),
        notify: (message: string) => {
          new Notice(message, NOTICE_MS);
        },
      })) as ConformanceReport | null;
      this.lastReport = report;
      this.warnedCheckFailed = false;
      return report;
    } catch (err) {
      // A failed check is NOT a verdict. Recording it as its own state keeps the
      // settings line from claiming a vault is fine when nothing was verified.
      this.lastReport = { failed: true, error: String((err as Error)?.message ?? err) };
      if (!this.warnedCheckFailed) {
        this.warnedCheckFailed = true;
        // eslint-disable-next-line no-console
        console.warn('[mcp-router-bridge] vault conformance check failed (skipped):', err);
      }
      return this.lastReport;
    }
  }

  /** Drop the stored report — used when the switch is turned off. */
  forget(): void {
    this.lastReport = null;
    this.warnedCheckFailed = false;
  }

  /** Human-readable status for the settings tab. */
  statusLine(): string {
    return statusLineForReport(this.lastReport, this.plugin.settings.conformanceCheckEnabled);
  }

  /**
   * Read a vault file, or null. `null` never means "conformant" downstream —
   * the core records an unreadable projection under `unreadable[]`, so a locked
   * or mid-sync file errs toward reporting rather than toward silence.
   */
  private async readOrNull(path: string): Promise<string | null> {
    try {
      return await this.plugin.app.vault.adapter.read(path);
    } catch {
      return null;
    }
  }
}
