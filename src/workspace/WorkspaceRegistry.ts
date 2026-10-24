import { WorkspaceDescriptor, WorkspaceRootDescriptor } from './WorkspaceTypes';
import { discoverWorkspaceCapabilities, WorkspaceCapabilities } from './PolyglotDiscovery';

export interface WorkspaceRootEntry {
  descriptor: WorkspaceRootDescriptor;
  capabilities: WorkspaceCapabilities;
}

/**
 * Holds one classified root + its discovered capabilities per VS Code
 * workspace folder, so "which root does this task target" has a real answer
 * beyond `workspaceFolders[0]`. A mission still executes against one root at
 * a time (existing single-root call sites are unaffected); this only makes
 * the *other* roots visible and selectable instead of silently dropped.
 */
export class WorkspaceRegistry {
  private readonly entries = new Map<string, WorkspaceRootEntry>();
  private primaryRootPath: string;

  private constructor(private readonly descriptor: WorkspaceDescriptor) {
    this.primaryRootPath = descriptor.primaryRoot.path;
  }

  static async build(descriptor: WorkspaceDescriptor): Promise<WorkspaceRegistry> {
    const registry = new WorkspaceRegistry(descriptor);
    await Promise.all(descriptor.roots.map(async root => {
      const capabilities = await discoverWorkspaceCapabilities(root);
      registry.entries.set(root.path, { descriptor: root, capabilities });
    }));
    return registry;
  }

  get roots(): WorkspaceRootEntry[] {
    return [...this.entries.values()];
  }

  get primaryRoot(): WorkspaceRootEntry {
    const entry = this.entries.get(this.primaryRootPath);
    if (!entry) {
      throw new Error(`Workspace registry has no entry for primary root: ${this.primaryRootPath}`);
    }
    return entry;
  }

  /** Root a task should target: an explicit path if given and known, else the primary root. */
  forTask(explicitRootPath?: string): WorkspaceRootEntry {
    if (explicitRootPath) {
      const entry = this.entries.get(explicitRootPath);
      if (entry) return entry;
    }
    return this.primaryRoot;
  }
}
