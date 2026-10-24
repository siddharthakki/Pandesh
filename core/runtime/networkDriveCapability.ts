import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { runPowerShellScript, type ShellExecResult } from './windowsShellExec';

export interface NetworkDriveCapabilityOptions {
  runScript?: typeof runPowerShellScript;
}

interface SmbMappingRow {
  LocalPath?: string;
  RemotePath?: string;
  Status?: string | number;
}

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

/** Single-quotes a value for safe interpolation into a PowerShell script
 * (doubling embedded single quotes, PowerShell's own escaping rule) — never
 * build a script by directly concatenating unescaped user-controlled input. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function validDriveLetter(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim().replace(/:$/, '').toUpperCase() : '';
  return /^[A-Z]$/.test(trimmed) ? trimmed : null;
}

function validUncPath(value: unknown): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return /^\\\\[^\\]+\\[^\\]+/.test(trimmed) ? trimmed : null;
}

function asRows(parsed: unknown): SmbMappingRow[] {
  if (Array.isArray(parsed)) return parsed as SmbMappingRow[];
  if (parsed && typeof parsed === 'object') return [parsed as SmbMappingRow];
  return [];
}

/**
 * Network drive awareness + approval-gated connect/disconnect (confirmed
 * scope — not full unrestricted management). Backed by Windows' built-in
 * SMB cmdlets via the same bounded PowerShell execution used elsewhere
 * (`windowsShellExec.ts`). Listing is read-only; connect/disconnect are
 * consequential like any other mutating capability, and a supplied password
 * is redacted before it ever reaches approval evidence.
 */
export function createNetworkDriveCapabilityAdapter(options: NetworkDriveCapabilityOptions = {}): GovernedCapabilityAdapter {
  const run = options.runScript ?? runPowerShellScript;

  async function listDrives(): Promise<ToolExecutionResult> {
    const result: ShellExecResult = await run('Get-SmbMapping | Select-Object LocalPath, RemotePath, Status | ConvertTo-Json -Compress');
    if (!result.succeeded) return failure(result.output || 'Get-SmbMapping failed', 'network_drive_list_failed');
    const trimmed = result.output.trim();
    if (!trimmed) return { status: 'succeeded', exitCode: 0, output: 'No network drives are currently mapped.', resultCategory: 'network_drives_listed' };
    let rows: SmbMappingRow[];
    try {
      rows = asRows(JSON.parse(trimmed));
    } catch {
      return failure(`Could not parse network drive list: ${trimmed}`, 'network_drive_list_unparseable');
    }
    const lines = rows.map((row) => `${row.LocalPath ?? '?'} -> ${row.RemotePath ?? '?'} (${row.Status ?? 'unknown'})`);
    return {
      status: 'succeeded', exitCode: 0,
      output: lines.join('\n') || 'No network drives are currently mapped.',
      resultCategory: 'network_drives_listed',
    };
  }

  async function connectDrive(call: ModelToolCall): Promise<ToolExecutionResult> {
    const driveLetter = validDriveLetter(call.arguments.driveLetter);
    if (!driveLetter) return failure('driveLetter must be a single letter, e.g. "Z"', 'invalid_arguments');
    const uncPath = validUncPath(call.arguments.uncPath);
    if (!uncPath) return failure('uncPath must look like \\\\server\\share', 'invalid_arguments');
    const username = typeof call.arguments.username === 'string' ? call.arguments.username.trim() : '';
    const password = typeof call.arguments.password === 'string' ? call.arguments.password : '';

    let script = `New-SmbMapping -LocalPath ${psQuote(`${driveLetter}:`)} -RemotePath ${psQuote(uncPath)} -Persistent $true`;
    if (username) script += ` -UserName ${psQuote(username)}`;
    if (password) script += ` -Password ${psQuote(password)}`;
    const result = await run(script);
    if (!result.succeeded) return failure(result.output || `Could not map ${driveLetter}: to ${uncPath}`, 'network_drive_connect_failed');
    return {
      status: 'succeeded', exitCode: 0,
      output: `Mapped ${driveLetter}: to ${uncPath}`,
      resultCategory: 'network_drive_connected',
      normalizedArguments: { driveLetter, uncPath, username: username || null },
    };
  }

  async function disconnectDrive(call: ModelToolCall): Promise<ToolExecutionResult> {
    const driveLetter = validDriveLetter(call.arguments.driveLetter);
    if (!driveLetter) return failure('driveLetter must be a single letter, e.g. "Z"', 'invalid_arguments');
    const result = await run(`Remove-SmbMapping -LocalPath ${psQuote(`${driveLetter}:`)} -Force -Confirm:$false`);
    if (!result.succeeded) return failure(result.output || `Could not disconnect ${driveLetter}:`, 'network_drive_disconnect_failed');
    return {
      status: 'succeeded', exitCode: 0,
      output: `Disconnected ${driveLetter}:`,
      resultCategory: 'network_drive_disconnected',
      normalizedArguments: { driveLetter },
    };
  }

  return {
    id: 'network-drives',
    definitions: () => [
      {
        name: 'list_network_drives',
        description: 'List currently mapped network drives (local drive letter, remote UNC path, connection status). Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'connect_network_drive',
        description: 'Map a network drive letter to a UNC share path (e.g. \\\\server\\share). Consequential and approval-gated.',
        parameters: {
          type: 'object',
          properties: {
            driveLetter: { type: 'string', description: 'A single unused drive letter, e.g. "Z".' },
            uncPath: { type: 'string', description: 'UNC path, e.g. \\\\server\\share.' },
            username: { type: 'string' },
            password: { type: 'string' },
          },
          required: ['driveLetter', 'uncPath'],
        },
      },
      {
        name: 'disconnect_network_drive',
        description: 'Disconnect (unmap) a currently mapped network drive letter. Consequential and approval-gated.',
        parameters: { type: 'object', properties: { driveLetter: { type: 'string' } }, required: ['driveLetter'] },
      },
    ],
    classify: (toolName) => (toolName === 'list_network_drives' ? 'read_only' : 'consequential'),
    health: () => ({ state: process.platform === 'win32' ? 'available' : 'unavailable', reason: process.platform === 'win32' ? undefined : 'network drive mapping is Windows-only', checkedAt: new Date().toISOString() }),
    redactArguments: (toolName, args) => (toolName === 'connect_network_drive' && typeof args.password === 'string'
      ? { ...args, password: '[redacted]' }
      : args),
    run: (call) => {
      if (call.name === 'list_network_drives') return listDrives();
      if (call.name === 'connect_network_drive') return connectDrive(call);
      if (call.name === 'disconnect_network_drive') return disconnectDrive(call);
      return Promise.resolve(failure(`unknown tool '${call.name}'`, 'invalid_arguments'));
    },
  };
}
