import * as fs from 'fs/promises';
import * as path from 'path';
import { AutomationState, validateAutomationDefinition } from './AutomationTypes';

export interface AutomationStorage {
  loadAll(): Promise<AutomationState[]>;
  save(state: AutomationState): Promise<void>;
  remove(id: string): Promise<void>;
}

export class FileAutomationStorage implements AutomationStorage {
  constructor(private readonly directory: string) {}

  async loadAll(): Promise<AutomationState[]> {
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(this.directory, { withFileTypes: true });
    } catch {
      return [];
    }

    const states: AutomationState[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(this.directory, entry.name), 'utf8')) as AutomationState;
        validateAutomationDefinition(parsed);
        if (!Array.isArray(parsed.completedMutationKeys)) continue;
        states.push(parsed);
      } catch {
        // Malformed state is intentionally left for diagnostics instead of being rewritten.
      }
    }
    return states.sort((left, right) => left.id.localeCompare(right.id));
  }

  async save(state: AutomationState): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = path.join(this.directory, `${safeFilename(state.id)}.json`);
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, target);
  }

  async remove(id: string): Promise<void> {
    await fs.rm(path.join(this.directory, `${safeFilename(id)}.json`), { force: true });
  }
}

export class InMemoryAutomationStorage implements AutomationStorage {
  private readonly states = new Map<string, AutomationState>();

  async loadAll(): Promise<AutomationState[]> {
    return [...this.states.values()].map(cloneState).sort((left, right) => left.id.localeCompare(right.id));
  }

  async save(state: AutomationState): Promise<void> {
    this.states.set(state.id, cloneState(state));
  }

  async remove(id: string): Promise<void> {
    this.states.delete(id);
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function cloneState(state: AutomationState): AutomationState {
  return JSON.parse(JSON.stringify(state)) as AutomationState;
}
