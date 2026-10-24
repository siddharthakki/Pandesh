import * as path from 'path';
import { FileService } from '../services/FileService';

export interface EnterprisePolicy {
  allowedTools?: string[];
  deniedTools?: string[];
  allowedCommandPatterns?: string[];
  deniedCommandPatterns?: string[];
}

export class EnterprisePolicyLoader {
  private policy: EnterprisePolicy = {};

  async load(workspaceRoot: string): Promise<void> {
    const policyPath = path.join(workspaceRoot, '.ollama-agent', 'policy.json');
    const exists = await FileService.exists(policyPath);
    if (!exists) { return; }

    try {
      const text = await FileService.readText(policyPath);
      this.policy = JSON.parse(text) as EnterprisePolicy;
    } catch {
      // Invalid policy file — ignore and use defaults
    }
  }

  isToolDenied(toolName: string): boolean {
    if (this.policy.deniedTools?.includes(toolName)) { return true; }
    if (this.policy.allowedTools && !this.policy.allowedTools.includes(toolName)) { return true; }
    return false;
  }

  isCommandDenied(command: string): boolean {
    if (this.policy.deniedCommandPatterns) {
      for (const p of this.policy.deniedCommandPatterns) {
        if (new RegExp(p, 'i').test(command)) { return true; }
      }
    }
    return false;
  }

  isCommandAllowed(command: string): boolean {
    if (!this.policy.allowedCommandPatterns || this.policy.allowedCommandPatterns.length === 0) {
      return false;
    }
    return this.policy.allowedCommandPatterns.some((p) => new RegExp(p, 'i').test(command));
  }
}
