import { AgentMode } from '../tools/ToolTypes';
import { Config } from '../config/Config';

export type PolicyAction = 'deny' | 'ask-once' | 'allow-once' | 'allow-for-task' | 'allow-for-session';

export interface PolicyDecision {
  action: PolicyAction;
  reason: string;
  fingerprint: string;
}

export interface ExternalToolRisk {
  readOnly: boolean;
  mutating: boolean;
  network: boolean;
  destructive?: boolean;
}

const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_file_range', 'list_directory', 'search_files', 'grep',
  'find_relevant', 'find_references', 'impact_analysis', 'repo_map',
  'git_status', 'git_diff', 'git_branch', 'git_log', 'get_document',
]);

const MUTATING_TOOLS = new Set([
  'edit_file', 'write_file', 'replace_in_file', 'apply_patch',
  'create_directory', 'delete_file', 'rename_file', 'move_file',
  'run_command', 'execute_code', 'git_commit', 'git_push',
  'git_checkout', 'git_reset', 'git_merge',
]);

const DENY_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(--no-preserve-root\s+)?-[rf]{1,2}\s+\/(?:\s|$|\*)/i, reason: 'Destructive: deletes the root filesystem' },
  { pattern: /del\s+\/[sfq]+\s+[A-Z]:\\\s*$/i, reason: 'Destructive: deletes an entire drive' },
  { pattern: /(?:rd|rmdir)\s+\/[sq]+\s+[A-Z]:\\\s*$/i, reason: 'Destructive: removes an entire drive tree' },
  { pattern: /Remove-Item\b[^\r\n]*-[^\r\n]*(?:Recurse|Force)[^\r\n]*[A-Z]:\\\s*$/i, reason: 'Destructive: removes an entire drive tree' },
  { pattern: /format(?:\.com)?\s+[A-Z]:\s*$/i, reason: 'Destructive: formats a drive' },
  { pattern: /\b(?:Format-Volume|Clear-Disk|Initialize-Disk)\b/i, reason: 'Destructive: modifies disk storage' },
  { pattern: /\bdd\s+if=\/dev\/zero\s+of=\/dev\/sd/i, reason: 'Destructive: overwrites a block device' },
  { pattern: /\bmkfs\b.*\/dev\/sd/i, reason: 'Destructive: formats a block device' },
  { pattern: /chmod\s+-R\s+777\s+\//i, reason: 'Destructive: makes the entire filesystem world-writable' },
  { pattern: /chown\s+-R\s+(root|0)\s*:\s*(root|0)\s+\//i, reason: 'Destructive: changes ownership of the entire filesystem' },
  { pattern: /(curl|wget)\s+\S+\s*\|\s*(bash|sh|powershell|cmd)/i, reason: 'Remote script execution: download and pipe to shell' },
  { pattern: /Invoke-WebRequest\s.*\|\s*(Invoke-Expression|iex)\b/i, reason: 'Remote script execution: download and execute' },
  { pattern: /\bIEX\s*\(\s*New-Object\s+Net\.WebClient/i, reason: 'Remote script execution: IEX and WebClient' },
  { pattern: /\biex\s*\([^)]*WebClient/i, reason: 'Remote script execution: Invoke-Expression and WebClient' },
  { pattern: /(?:powershell|pwsh)\b[^\r\n]*-(?:EncodedCommand|enc)\b/i, reason: 'Opaque execution: encoded PowerShell command' },
  { pattern: /\bsudo\s+(bash|sh|zsh|fish|ksh|dash|csh|tcsh|su)\b/i, reason: 'Privilege escalation: privileged shell' },
  { pattern: /\bsu\s*(-\s*(root|0)?\s*)?$/i, reason: 'Privilege escalation: switching to root' },
  { pattern: /\brunas\s+\/user:(administrator|system|root|admin)\b/i, reason: 'Privilege escalation: privileged runas' },
  { pattern: /Start-Process\s+.*-Verb\s+RunAs/i, reason: 'Privilege escalation: PowerShell RunAs' },
  { pattern: /\bsudo\s+(rm\s+-rf|dd\s+if=|mkfs|fdisk|parted)\b/i, reason: 'Privilege escalation with destructive command' },
];

const ASK_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /[|;&>!\r\n]/, category: 'shell-operator' },
  { pattern: /\bnpm\s+(install|ci|add)\b/i, category: 'package-install' },
  { pattern: /\bpnpm\s+(install|add)\b/i, category: 'package-install' },
  { pattern: /\byarn\s+(install|add)\b/i, category: 'package-install' },
  { pattern: /\bpip3?\s+install\b/i, category: 'package-install' },
  { pattern: /\bapt(-get)?\s+(install|remove|purge)\b/i, category: 'package-install' },
  { pattern: /\bbrew\s+(install|uninstall|remove)\b/i, category: 'package-install' },
  { pattern: /\bgit\s+(checkout|reset|clean|push|rebase|merge)\b/i, category: 'git-mutate' },
  { pattern: /\bdocker\s+(run|build|push|rm|rmi|stop|kill)\b/i, category: 'docker' },
  { pattern: /\bkubectl\s+(apply|delete|set|patch|exec)\b/i, category: 'kubernetes' },
  { pattern: /\bsudo\b/i, category: 'privilege' },
  { pattern: /\bcurl\b.*\s+-[oO]\s/i, category: 'network-download' },
  { pattern: /\bwget\b.*\s+-[oO]\s/i, category: 'network-download' },
  { pattern: /\bInvoke-WebRequest\b/i, category: 'network-download' },
  { pattern: /\bkill\s+(-\d+|-9|-KILL|-SIGKILL)?\s+\d/i, category: 'process-control' },
  { pattern: /\bpkill\b|\bkillall\b/i, category: 'process-control' },
  { pattern: /\btaskkill\s+\/[FT]/i, category: 'process-control' },
];

const SAFE_PATTERNS: RegExp[] = [
  /^git\s+(status|diff|log|branch|show)(?:\s+[^|;&>!\r\n]*)?$/i,
  /^npm\s+run\s+(build|test|lint|validate|compile|typecheck)(?:\s+--(?:\s+[^|;&>!\r\n]*)?)?$/i,
  /^npm\s+test(?:\s+--(?:\s+[^|;&>!\r\n]*)?)?$/i,
  /^npx\s+(tsc|vitest|eslint|prettier)(?:\s+[^|;&>!\r\n]*)?$/i,
  /^tsc(?:\s+[^|;&>!\r\n]*)?$/i,
  /^(?:ls|dir|pwd)(?:\s+[^|;&>!\r\n]*)?$/i,
  /^(?:which|where)\s+[^|;&>!\r\n]+$/i,
];

function computeFingerprint(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${JSON.stringify(args)}`;
}

export class PolicyEngine {
  private readonly rejectedFingerprints = new Set<string>();

  evaluate(toolName: string, args: Record<string, unknown>, mode?: AgentMode): PolicyDecision {
    const fingerprint = computeFingerprint(toolName, args);
    if (this.rejectedFingerprints.has(fingerprint)) {
      return { action: 'deny', reason: 'This exact tool call was previously rejected by the user.', fingerprint };
    }
    if (mode === 'chat') {
      return { action: 'deny', reason: 'Tool execution is disabled in Chat mode.', fingerprint };
    }
    if ((mode === 'ask' || mode === 'plan') && MUTATING_TOOLS.has(toolName)) {
      return { action: 'deny', reason: `Tool "${toolName}" is not permitted in ${mode} mode.`, fingerprint };
    }
    if (READ_ONLY_TOOLS.has(toolName)) {
      return { action: 'allow-once', reason: 'Read-only tool permitted.', fingerprint };
    }

    if (toolName === 'run_command') {
      const command = String(args['command'] ?? '').trim();
      if (!command) {
        return { action: 'deny', reason: 'Command is empty.', fingerprint };
      }
      for (const { pattern, reason } of DENY_PATTERNS) {
        if (pattern.test(command)) { return { action: 'deny', reason: `Blocked: ${reason}`, fingerprint }; }
      }
      for (const { pattern, category } of ASK_PATTERNS) {
        if (pattern.test(command)) {
          return { action: 'ask-once', reason: `Command requires approval: ${category}.`, fingerprint };
        }
      }
      for (const pattern of SAFE_PATTERNS) {
        if (pattern.test(command)) {
          return Config.getRequireApprovalForCommands()
            ? { action: 'ask-once', reason: 'Command approval is enabled.', fingerprint }
            : { action: 'allow-once', reason: 'Bounded read or validation command permitted.', fingerprint };
        }
      }
      return { action: 'ask-once', reason: 'Unclassified command requires user approval.', fingerprint };
    }

    if (MUTATING_TOOLS.has(toolName)) {
      return Config.getRequireApprovalForWrites()
        ? { action: 'ask-once', reason: 'File write approval is enabled.', fingerprint }
        : { action: 'allow-once', reason: 'File write permitted by configuration.', fingerprint };
    }

    return { action: 'deny', reason: `Unknown tool is not permitted: ${toolName}`, fingerprint };
  }

  evaluateExternalTool(
    toolName: string,
    args: Record<string, unknown>,
    risk: ExternalToolRisk,
    mode?: AgentMode,
  ): PolicyDecision {
    const fingerprint = computeFingerprint(toolName, args);
    if (this.rejectedFingerprints.has(fingerprint)) {
      return { action: 'deny', reason: 'This exact external tool call was previously rejected by the user.', fingerprint };
    }
    if (mode === 'chat') {
      return { action: 'deny', reason: 'External tool execution is disabled in Chat mode.', fingerprint };
    }
    if (risk.destructive) {
      return { action: 'deny', reason: 'Destructive external tools are blocked.', fingerprint };
    }
    if ((mode === 'ask' || mode === 'plan') && risk.mutating) {
      return { action: 'deny', reason: `Mutating external tools are not permitted in ${mode} mode.`, fingerprint };
    }
    if (risk.readOnly && !risk.mutating && !risk.network) {
      return { action: 'allow-once', reason: 'Local read-only external tool permitted.', fingerprint };
    }
    if (risk.network) {
      return { action: 'ask-once', reason: 'External network access requires approval.', fingerprint };
    }
    if (risk.mutating) {
      return Config.getRequireApprovalForWrites()
        ? { action: 'ask-once', reason: 'External mutation requires approval.', fingerprint }
        : { action: 'allow-once', reason: 'External mutation permitted by configuration.', fingerprint };
    }
    return { action: 'deny', reason: 'External tool risk is not explicitly classified.', fingerprint };
  }

  recordRejection(fingerprint: string): void {
    this.rejectedFingerprints.add(fingerprint);
  }

  isRejected(fingerprint: string): boolean {
    return this.rejectedFingerprints.has(fingerprint);
  }

  clearRejections(): void {
    this.rejectedFingerprints.clear();
  }

  classifyCommand(command: string): { isDangerous: boolean; category: string; reason: string } {
    for (const { pattern, reason } of DENY_PATTERNS) {
      if (pattern.test(command)) { return { isDangerous: true, category: 'denied', reason }; }
    }
    for (const { pattern, category } of ASK_PATTERNS) {
      if (pattern.test(command)) { return { isDangerous: false, category, reason: `Requires approval: ${category}` }; }
    }
    for (const pattern of SAFE_PATTERNS) {
      if (pattern.test(command.trim())) {
        return { isDangerous: false, category: 'safe', reason: 'Matches bounded safe pattern' };
      }
    }
    return { isDangerous: false, category: 'unclassified', reason: 'No policy pattern matched' };
  }
}
