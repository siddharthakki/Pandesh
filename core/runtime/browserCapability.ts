/**
 * Core-owned governed browser inspection capability.
 *
 * Inspects a workspace HTML page through a host-managed browser already on
 * disk. Never installs packages, never accepts an arbitrary URL, and writes
 * screenshots only under `<workspace>/.tmp/karkedikha-browser`.
 */
import type { ModelToolDefinition, ModelToolCall } from './modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from './toolRunner';
import type { CapabilityHealth, GovernedCapabilityAdapter } from './governedCapability';
import { resolveHostBrowserBin } from './hostBrowserBin';
import {
  BROWSER_OUTPUT_DIR,
  runWorkspacePageInspection,
  type BrowserInspectStep,
  type BrowserInspectionRunner,
} from './browserInspection';
import { parsePageLocator } from './pageLocator';

const MAX_OUTPUT_CHARS = 8_000;
const MAX_STEPS = 12;

function bound(text: string): string {
  return text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated]` : text;
}

function asSteps(raw: unknown): BrowserInspectStep[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_STEPS).map((item) => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const action = record.action === 'fill' || record.action === 'wait' || record.action === 'focus' || record.action === 'key'
      ? record.action
      : 'click';
    return {
      action,
      selector: typeof record.selector === 'string' ? record.selector : undefined,
      locator: parsePageLocator(record.locator),
      value: typeof record.value === 'string' ? record.value : undefined,
      key: typeof record.key === 'string' ? record.key : undefined,
      ms: typeof record.ms === 'number' ? record.ms : undefined,
    };
  });
}

export interface BrowserCapabilityOptions {
  runner?: BrowserInspectionRunner;
  browserBin?: string | null;
  env?: NodeJS.ProcessEnv;
}

export function createBrowserCapabilityAdapter(options: BrowserCapabilityOptions = {}): GovernedCapabilityAdapter {
  const env = options.env ?? process.env;
  const definitions: ModelToolDefinition[] = [
    {
      name: 'inspect_page',
      description:
        `Host-managed browser inspection of a real page. Pass either a repository-relative path such as index.html, or a live URL on this machine (http://127.0.0.1:<port>/... or http://localhost:<port>/...) to open an app that is already running. Optional viewportWidth/viewportHeight (use ~1280 desktop and ~390 mobile) and steps (click/fill/wait/focus/key). Screenshots are written under ${BROWSER_OUTPUT_DIR}. Do not install browsers or npm packages, and do not search for browser executables.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative HTML path, e.g. index.html.' },
          url: { type: 'string', description: 'Live page URL on this machine (loopback only). Use this for an app that is already running.' },
          viewportWidth: { type: 'number', description: 'Viewport width in CSS pixels.' },
          viewportHeight: { type: 'number', description: 'Viewport height in CSS pixels.' },
          steps: {
            type: 'array',
            description: 'Optional interactions before the snapshot (click, fill, wait).',
            items: {
              type: 'object',
              properties: {
                action: { type: 'string', description: 'click, fill, or wait.' },
                selector: { type: 'string', description: 'CSS selector for a baseline or story-required element.' },
                locator: {
                  type: 'object',
                  description: 'Semantic locator: role/name, label, visible text, or css.',
                },
                value: { type: 'string' },
                ms: { type: 'number' },
              },
            },
          },
        },
        required: ['path'],
      },
    },
  ];

  return {
    id: 'browser',
    definitions: () => definitions,
    classify: () => 'consequential',
    health: () => {
      const browserBin = options.browserBin === undefined ? resolveHostBrowserBin(env) : options.browserBin;
      if (!browserBin) {
        return {
          state: 'unavailable',
          reason: 'no host browser binary; set KARKEDIKHA_BROWSER_BIN',
          checkedAt: new Date().toISOString(),
        };
      }
      return { state: 'available', checkedAt: new Date().toISOString() };
    },
    run: async (call: ModelToolCall, ctx: ToolExecutionContext): Promise<ToolExecutionResult> => {
      const relativePath = String(call.arguments.path ?? '').trim();
      const liveUrl = String(call.arguments.url ?? '').trim();
      const normalizedArguments = {
        path: relativePath,
        url: liveUrl,
        viewportWidth: call.arguments.viewportWidth ?? 1280,
        viewportHeight: call.arguments.viewportHeight ?? 800,
        stepCount: Array.isArray(call.arguments.steps) ? call.arguments.steps.length : 0,
      };
      if (!relativePath && !liveUrl) {
        return {
          status: 'failed',
          exitCode: null,
          output: 'inspect_page requires a workspace-relative path or a live URL',
          resultCategory: 'browser_invalid_arguments',
          normalizedArguments,
        };
      }
      try {
        const result = await runWorkspacePageInspection({
          workspaceRoot: ctx.cwd,
          relativePath,
          ...(liveUrl ? { url: liveUrl } : {}),
          viewportWidth: Number(call.arguments.viewportWidth),
          viewportHeight: Number(call.arguments.viewportHeight),
          steps: asSteps(call.arguments.steps),
          runner: options.runner,
          browserBin: options.browserBin === undefined ? resolveHostBrowserBin(env) : options.browserBin,
          signal: ctx.signal,
        });
        return {
          status: 'succeeded',
          exitCode: 0,
          output: bound(JSON.stringify({
            title: result.title,
            url: result.url,
            viewport: result.viewport,
            screenshotPath: result.screenshotPath,
            snapshot: result.snapshot,
          })),
          resultCategory: 'browser_inspect_succeeded',
          normalizedArguments: { ...normalizedArguments, screenshotPath: result.screenshotPath },
        };
      } catch (err) {
        return {
          status: 'failed',
          exitCode: 1,
          output: bound(err instanceof Error ? err.message : String(err)),
          resultCategory: 'browser_inspect_failed',
          normalizedArguments,
        };
      }
    },
  };
}
