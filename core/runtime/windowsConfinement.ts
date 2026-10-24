/**
 * Core-owned Windows confinement prototype.
 *
 * This wraps a small helper compiled with the host Framework csc. It launches
 * a harmless probe inside an AppContainer plus Job Object. Copilot is never
 * installed or spawned. Loopback exemptions are never added.
 *
 * Mechanisms, from Microsoft Learn:
 * - AppContainer dual-principal DACL and CreateProcess SECURITY_CAPABILITIES
 *   https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
 * - Job Objects, nested jobs, KILL_ON_JOB_CLOSE, TerminateJobObject
 *   https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
 * - AppContainer loopback exemption is all-ports and debugging-only
 *   https://learn.microsoft.com/en-us/windows/win32/api/netfw/nf-netfw-networkisolationsetappcontainerconfig
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LOCAL_MODEL_ENDPOINT } from './workerDiscovery';

export const SYNTHETIC_SECRET = 'kdk-synthetic-secret-not-a-real-credential-9f3a';

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

export interface ProbeAction {
  id: string;
  op: 'write' | 'read' | 'http' | 'sleep' | 'spawn';
  path?: string;
  content?: string;
  url?: string;
  ms?: number;
  file?: string;
  arguments?: string;
  holdMs?: number;
}

export interface ProbeActionResult {
  id: string;
  op: string;
  ok: boolean;
  output: string | null;
  error: string | null;
  ms: number;
}

export interface LaunchReport {
  ok: boolean;
  error?: string;
  appContainerSid?: string;
  jobAssigned?: boolean;
  jobAssignError?: number;
  processId?: number;
  exitCode?: number;
  canceled?: boolean;
  usedConstructedEnv?: boolean;
  jobPids?: number[];
  jobEmpty?: boolean;
  wfp?: { attempted: boolean; opened: boolean; status: number };
}

export interface ConfinementRun {
  report: LaunchReport;
  actions: ProbeActionResult[];
}

function sourcePath(): string {
  const beside = path.join(__dirname, 'windowsConfinement', 'WindowsConfinementLauncher.cs');
  if (fs.existsSync(beside)) return beside;
  return path.join(process.cwd(), 'core', 'runtime', 'windowsConfinement', 'WindowsConfinementLauncher.cs');
}

export function compileWindowsConfinementLauncher(outDir: string): string {
  if (process.platform !== 'win32') throw new Error('Windows confinement prototype is win32-only');
  if (!fs.existsSync(CSC)) throw new Error(`Framework csc not found at ${CSC}`);
  fs.mkdirSync(outDir, { recursive: true });
  const exe = path.join(outDir, 'WindowsConfinementLauncher.exe');
  const src = sourcePath();
  const compiled = spawnSync(CSC, ['/nologo', '/optimize+', '/target:exe', `/out:${exe}`, src], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (compiled.status !== 0) {
    throw new Error(`csc failed (${compiled.status}): ${compiled.stdout}\n${compiled.stderr}`);
  }
  if (!fs.existsSync(exe)) throw new Error('csc produced no executable');
  return exe;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return (result.stdout || '').trim();
}

export interface ConfinementFixture {
  root: string;
  main: string;
  workspace: string;
  scratch: string;
  outside: string;
  gitFile: string;
  gitDir: string;
  commonDir: string;
  secretPath: string;
}

export function createConfinementFixture(root?: string): ConfinementFixture {
  const dir = root ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-confine-'));
  const main = path.join(dir, 'main');
  const workspace = path.join(dir, 'worktree');
  const scratch = path.join(dir, 'scratch');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(main, { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  git(main, ['init', '--quiet', '--initial-branch=main']);
  git(main, ['config', 'user.email', 'confine@karkedikha.local']);
  git(main, ['config', 'user.name', 'KarkeDikha Confine']);
  fs.writeFileSync(path.join(main, 'README.md'), '# confinement fixture\n');
  git(main, ['add', 'README.md']);
  git(main, ['commit', '--quiet', '-m', 'fixture']);
  git(main, ['worktree', 'add', '--quiet', workspace, 'HEAD']);
  const gitFile = path.join(workspace, '.git');
  const gitDir = git(workspace, ['rev-parse', '--absolute-git-dir']);
  const commonDir = git(workspace, ['rev-parse', '--git-common-dir']);
  const secretPath = path.join(outside, 'credential.txt');
  fs.writeFileSync(secretPath, SYNTHETIC_SECRET);
  return {
    root: dir,
    main,
    workspace,
    scratch,
    outside,
    gitFile,
    gitDir,
    commonDir: path.resolve(workspace, commonDir),
    secretPath,
  };
}

function parseJson(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error(`launcher produced no JSON: ${text}`);
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

export function runWindowsConfinement(input: {
  launcher: string;
  fixture: ConfinementFixture;
  actions: ProbeAction[];
  cancelAfterMs?: number;
  timeoutMs?: number;
  appContainerName?: string;
}): ConfinementRun {
  const planPath = path.join(input.fixture.scratch, 'plan.json');
  const resultPath = path.join(input.fixture.scratch, 'result.json');
  const probeExe = path.join(input.fixture.scratch, 'WindowsConfinementLauncher.exe');
  fs.copyFileSync(input.launcher, probeExe);
  fs.writeFileSync(planPath, JSON.stringify({ actions: input.actions }));
  const request = {
    appContainerName: input.appContainerName ?? `kdk.confine.${Date.now().toString(16)}`,
    executable: probeExe,
    arguments: `probe "${planPath}" "${resultPath}"`,
    cwd: input.fixture.workspace,
    workspace: input.fixture.workspace,
    scratch: input.fixture.scratch,
    denyWrite: [input.fixture.gitFile, input.fixture.gitDir, input.fixture.commonDir],
    env: [
      `SystemRoot=${process.env.SystemRoot ?? 'C:\\Windows'}`,
      `windir=${process.env.windir ?? 'C:\\Windows'}`,
      `SystemDrive=C:`,
      `OS=Windows_NT`,
      `ComSpec=${path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')}`,
      `PATHEXT=.COM;.EXE;.BAT;.CMD`,
      `Path=${path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`,
      `ALLUSERSPROFILE=C:\\ProgramData`,
      `ProgramData=C:\\ProgramData`,
      `PUBLIC=C:\\Users\\Public`,
      `TMP=${input.fixture.scratch}`,
      `TEMP=${input.fixture.scratch}`,
      `USERPROFILE=${input.fixture.scratch}`,
      `LOCALAPPDATA=${input.fixture.scratch}`,
      `APPDATA=${input.fixture.scratch}`,
      `USERNAME=kdk-confine`,
      `USERDOMAIN=kdk-confine`,
    ],
    timeoutMs: input.timeoutMs ?? 20000,
    cancelAfterMs: input.cancelAfterMs ?? 0,
  };
  const requestPath = path.join(input.fixture.scratch, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const launched = spawnSync(input.launcher, ['launch', requestPath], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: (input.timeoutMs ?? 20000) + 15000,
  });
  const reportPath = `${requestPath}.report.json`;
  const combined = `${launched.stdout ?? ''}\n${launched.stderr ?? ''}`;
  let report: LaunchReport;
  try {
    if (fs.existsSync(reportPath)) {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8').replace(/^\uFEFF/, '')) as LaunchReport;
    } else {
      report = parseJson(combined) as unknown as LaunchReport;
    }
  } catch (err) {
    throw new Error(`launcher failed (${launched.status} ${launched.error?.message ?? ''} ${launched.signal ?? ''}): ${combined}\n${(err as Error).message}`);
  }
  let actions: ProbeActionResult[] = [];
  if (fs.existsSync(resultPath)) {
    const raw = fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '');
    const body = JSON.parse(raw) as { actions?: ProbeActionResult[] };
    actions = body.actions ?? [];
  }
  return { report, actions };
}

export function actionById(run: ConfinementRun, id: string): ProbeActionResult | undefined {
  return run.actions.find((item) => item.id === id);
}

export function defaultBoundaryActions(fixture: ConfinementFixture): ProbeAction[] {
  return [
    { id: 'writeWorkspace', op: 'write', path: path.join(fixture.workspace, 'allowed.txt'), content: 'workspace-ok' },
    { id: 'writeScratch', op: 'write', path: path.join(fixture.scratch, 'allowed.txt'), content: 'scratch-ok' },
    { id: 'readWorkspace', op: 'read', path: path.join(fixture.workspace, 'README.md') },
    { id: 'writeOutside', op: 'write', path: path.join(fixture.outside, 'pwn.txt'), content: 'should-not-land' },
    { id: 'writeGitFile', op: 'write', path: fixture.gitFile, content: 'gitdir: C:\\Windows\\Temp\\evil' },
    { id: 'writeGitDir', op: 'write', path: path.join(fixture.gitDir, 'evil-ref'), content: 'evil' },
    { id: 'writeCommonDir', op: 'write', path: path.join(fixture.commonDir, 'hooks', 'evil.hook'), content: 'evil' },
    { id: 'readSecret', op: 'read', path: fixture.secretPath },
    { id: 'httpOllama', op: 'http', url: `${LOCAL_MODEL_ENDPOINT}/api/version` },
    { id: 'httpOtherLoopback', op: 'http', url: 'http://127.0.0.1:1/' },
    { id: 'httpExternal', op: 'http', url: 'http://1.1.1.1/' },
  ];
}
