import { AgentMode, RegisteredTool, ToolContext, ToolResult } from './ToolTypes';
import { TOOL_SCHEMAS } from './ToolSchemas';
import { validateToolArguments } from './ToolArgumentValidator';
import * as fileTools from './fileTools';
import * as searchTools from './searchTools';
import * as terminalTool from './terminalTool';
import * as gitTools from './gitTools';
import * as navigationTools from './navigationTools';
import {
  GovernedToolRegistry,
  governedDefinitionFromToolSchema,
} from './GovernedToolRegistry';
import { GrantedPermissionSet } from './PermissionProfiles';

export interface ExtendedToolContext extends ToolContext {
  signal?: AbortSignal;
}

const REGISTRY = new Map<string, RegisteredTool>();
const GOVERNED_REGISTRY = new GovernedToolRegistry();

function schema(name: string) {
  const definition = TOOL_SCHEMAS.find(tool => tool.function.name === name);
  if (!definition) { throw new Error(`Schema not found for tool: ${name}`); }
  return definition;
}

function register(
  name: string,
  execute: (args: Record<string, unknown>, ctx: ExtendedToolContext) => Promise<ToolResult>,
  riskLevel: RegisteredTool['riskLevel'],
  mutatesWorkspace: boolean,
  requiresWorkspace: boolean,
): void {
  const definition = schema(name);
  REGISTRY.set(name, {
    schema: definition,
    execute: async (args, ctx) => {
      const validation = validateToolArguments(definition, args);
      if (!validation.ok) {
        return {
          ok: false,
          error: validation.error,
          blocked: true,
          policyViolation: true,
        };
      }
      return execute(args, ctx);
    },
    riskLevel,
    mutatesWorkspace,
    requiresWorkspace,
  });
  GOVERNED_REGISTRY.register(governedDefinitionFromToolSchema({
    schema: definition,
    riskLevel,
    mutatesWorkspace,
    requiresWorkspace,
  }));
}

register('read_file', fileTools.readFile, 'safe', false, true);
register('read_file_range', fileTools.readFileRange, 'safe', false, true);
register('edit_file', fileTools.editFile, 'medium', true, true);
register('write_file', fileTools.writeFile, 'medium', true, true);
register('propose_file_change', fileTools.proposeFileChange, 'medium', false, true);
register('replace_in_file', fileTools.replaceInFile, 'medium', true, true);
register('apply_patch', fileTools.applyPatch, 'medium', true, true);
register('list_directory', fileTools.listDirectory, 'safe', false, true);
register('create_directory', fileTools.createDirectory, 'low', true, true);

register('search_files', searchTools.searchFiles, 'safe', false, true);
register('grep', searchTools.grep, 'safe', false, true);
register('find_relevant', navigationTools.findRelevant, 'safe', false, true);
register('find_references', navigationTools.findReferences, 'safe', false, true);
register('impact_analysis', navigationTools.impactAnalysis, 'safe', false, true);
register('repo_map', navigationTools.repoMap, 'safe', false, true);

register(
  'run_command',
  (args, ctx) => terminalTool.runCommand(args, ctx, ctx.signal),
  'high',
  false,
  true,
);

register('git_status', gitTools.gitStatus, 'safe', false, true);
register('git_diff', gitTools.gitDiff, 'safe', false, true);
register('git_branch', gitTools.gitBranch, 'safe', false, true);
register('git_log', gitTools.gitLog, 'safe', false, true);

/**
 * M38: Core-backed governed external-service tools. Deliberately NOT routed
 * through `register()` — they must never gain a `GovernedToolRegistry` entry,
 * since Core (not this local registry) is the sole authorization/evidence
 * authority for them (ADR-7). `ToolExecutor.execute()` intercepts these tool
 * names before reaching `tool.execute()`, so this stub is never actually
 * invoked in the live product; it exists only so `ToolRegistry.get()` resolves
 * a schema for the model-facing tool list.
 */
function registerCoreBackedCapability(name: string): void {
  const definition = schema(name);
  REGISTRY.set(name, {
    schema: definition,
    execute: async () => ({ ok: false, error: `'${name}' must be dispatched through ToolExecutor's Core-backed capability bridge, not called directly` }),
    riskLevel: 'high',
    mutatesWorkspace: false,
    requiresWorkspace: false,
  });
}

registerCoreBackedCapability('governed_research');
registerCoreBackedCapability('github_read_issue');
registerCoreBackedCapability('github_comment_on_issue');
// M39 governed memory capability — same rationale: Core owns authorization,
// execution, and evidence; this registry only resolves the model-facing schema.
registerCoreBackedCapability('memory_remember');
registerCoreBackedCapability('memory_recall');
registerCoreBackedCapability('memory_resolve_contradiction');
registerCoreBackedCapability('memory_impact');
registerCoreBackedCapability('memory_export');
registerCoreBackedCapability('memory_forget');

export class ToolRegistry {
  static get(name: string): RegisteredTool | undefined {
    return REGISTRY.get(name);
  }

  static has(name: string): boolean {
    return REGISTRY.has(name);
  }

  static all(): RegisteredTool[] {
    return Array.from(REGISTRY.values());
  }

  static allSchemas() {
    return ToolRegistry.all().map(tool => tool.schema);
  }

  static schemasForMode(mode: AgentMode) {
    if (mode === 'chat') { return []; }
    if (mode === 'ask' || mode === 'plan') {
      return ToolRegistry.all()
        .filter(tool => tool.riskLevel === 'safe' && !tool.mutatesWorkspace)
        .map(tool => tool.schema);
    }
    return ToolRegistry.allSchemas();
  }

  static governed() {
    return GOVERNED_REGISTRY.list();
  }

  static resolveGoverned(id: string) {
    return GOVERNED_REGISTRY.resolve(id);
  }

  static authorizeGoverned(id: string, grants: GrantedPermissionSet) {
    return GOVERNED_REGISTRY.authorize(id, grants);
  }
}
