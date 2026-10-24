/**
 * VS Code adapter for the portable Skill Runtime.
 *
 * Loads built-in skills plus user-installed skills (extension storage) and workspace skills (`.ollama-agent/skills`,
 * `.karkedikha/skills`, `skills/`), resolves a handful per turn, and exposes one Setup capability row. Skills here only
 * ever become short advisory text appended to the turn's repository context; governance is enforced elsewhere and is not
 * an input to (or output of) this service.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Config } from '../config/Config';
import { Logger } from '../services/Logger';
import { SkillRegistry, resolveSkills, type ResolvedSkills } from '../../core/platform/skills/skillRuntime';
import { loadSkillDirectory, registerBuiltinSkills } from '../../core/platform/skills/skillSources';
import { registerCapability } from '../onboarding/CapabilityRegistry';

export type TurnKind = 'baat_kar' | 'saath_kar' | 'karke_dikha';

/** What each mode may *request*; every request is still approval/policy gated at execution time. */
const GRANTED_BY_KIND: Record<TurnKind, readonly string[]> = {
  baat_kar: ['workspace.read'],
  saath_kar: ['workspace.read', 'workspace.write', 'terminal.execute'],
  karke_dikha: ['workspace.read', 'workspace.write', 'terminal.execute'],
};

export interface TurnSkillRequest {
  intent: string;
  kind: TurnKind;
  model?: { vision?: boolean; tools?: boolean; contextWindow?: number };
  browserAvailable?: boolean;
  approvedHashes?: ReadonlySet<string>;
}

export class SkillRuntimeService implements vscode.Disposable {
  private static readonly instances = new Map<string, SkillRuntimeService>();
  static forWorkspace(context: vscode.ExtensionContext, root: string): SkillRuntimeService {
    const key = path.resolve(root || '.').toLowerCase();
    let service = this.instances.get(key);
    if (!service) {
      service = new SkillRuntimeService(context, root);
      this.instances.set(key, service);
      context.subscriptions?.push(service);
    }
    return service;
  }

  readonly registry = new SkillRegistry();
  private loaded?: Promise<void>;
  private rejected = 0;
  private readonly registration: { dispose(): void };

  private constructor(private readonly context: vscode.ExtensionContext, private readonly root: string) {
    registerBuiltinSkills(this.registry);
    this.registration = registerCapability('skills', () => this.capabilityRow());
  }

  /** (Re)loads user and workspace skills. Built-ins are always present; failures never throw. */
  refresh(): Promise<void> {
    this.loaded = (async () => {
      this.registry.clear('user');
      this.registry.clear('workspace');
      this.rejected = 0;
      const storage = this.context.globalStorageUri?.fsPath;
      const sources: Array<[string, 'user' | 'workspace']> = [];
      if (storage) sources.push([path.join(storage, 'skills'), 'user']);
      if (this.root) for (const dir of ['.ollama-agent/skills', '.karkedikha/skills', 'skills']) sources.push([path.join(this.root, dir), 'workspace']);
      for (const [dir, source] of sources) {
        try {
          const report = await loadSkillDirectory(this.registry, dir, source);
          this.rejected += report.rejected.length;
          for (const rejected of report.rejected) Logger.warn(`[Skills] ${rejected.origin}: ${rejected.reason}`);
        } catch (error) {
          Logger.warn(`[Skills] could not read ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    })();
    return this.loaded;
  }

  async ensureLoaded(): Promise<void> { await (this.loaded ?? this.refresh()); }

  /** Skills for one turn, or undefined when skills are turned off. */
  async resolveForTurn(request: TurnSkillRequest): Promise<ResolvedSkills | undefined> {
    if (!Config.getSkillsEnabled()) return undefined;
    await this.ensureLoaded();
    return resolveSkills(this.registry, {
      intent: request.intent,
      grantedCapabilities: new Set(GRANTED_BY_KIND[request.kind]),
      workspaceOpen: Boolean(this.root),
      workspaceTrusted: (vscode.workspace as { isTrusted?: boolean }).isTrusted !== false,
      browserAvailable: request.browserAvailable === true,
      ...(request.model ? { model: request.model } : {}),
      ...(request.approvedHashes ? { approvedHashes: request.approvedHashes } : {}),
      maxSkills: 3,
      budgetTokens: 600,
    });
  }

  capabilityRow(): { name: string; status: 'ok' | 'off' | 'warn'; detail: string } {
    if (!Config.getSkillsEnabled()) return { name: 'Skills', status: 'off', detail: 'Skills are turned off' };
    const all = this.registry.list();
    const external = all.filter(skill => skill.trust !== 'builtin').length;
    const detail = `${all.length} available${external ? ` (${external} yours or from this workspace)` : ''}${this.rejected ? ` · ${this.rejected} file(s) rejected` : ''}`;
    return { name: 'Skills', status: this.rejected ? 'warn' : 'ok', detail };
  }

  dispose(): void {
    this.registration.dispose();
    for (const [key, value] of SkillRuntimeService.instances) if (value === this) SkillRuntimeService.instances.delete(key);
  }
}
