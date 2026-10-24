/**
 * Windows Sandbox clean-install acceptance for the production Pandesh installer.
 *
 *   npm run desktop:smoke:sandbox          full run: launches Windows Sandbox and installs Pandesh in it
 *   npm run desktop:smoke:sandbox:check    static checks only: reconciliation, staging, PowerShell 5.1 parse, .wsb validation
 *
 * The run only succeeds when Windows Sandbox actually starts, the guest installs the installer under test and
 * reports every required check as PASS. Exit code 0 means exactly that and nothing less.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  GUEST, generateWsb, validateGuestReport, validateWsbHostFolders, validateWsbText,
} from './sandbox-smoke-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, '..', '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const checkOnly = process.argv.includes('--check');

const STARTUP_TIMEOUT_MS = 6 * 60 * 1000; // Sandbox must boot and the guest script must begin.
const GUEST_TIMEOUT_MS = 25 * 60 * 1000;  // Whole guest run: install, launch, probe, uninstall.
const SHUTDOWN_TIMEOUT_MS = 90 * 1000;
const SANDBOX_PROCESSES = ['WindowsSandbox.exe', 'WindowsSandboxClient.exe', 'WindowsSandboxRemoteSession.exe', 'WindowsSandboxServer.exe'];
const SOURCE_PATHSPEC = [
  'core', 'apps', 'scripts', 'src', 'package.json', 'package-lock.json', 'esbuild.core.js',
  ':(exclude)apps/desktop/scripts/sandbox-smoke',
  ':(exclude)apps/desktop/test',
];

const timeline = [];
const note = (event, detail = '') => {
  const entry = { at: new Date().toISOString(), event, detail };
  timeline.push(entry);
  console.log(`[sandbox-smoke] ${entry.at} ${event}${detail ? ` - ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message) {
  throw new Error(message);
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').toUpperCase();
}

function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function runningSandboxProcesses() {
  const result = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const names = String(result.stdout).split(/\r?\n/).map((line) => line.split('","')[0]?.replace(/^"/, '')).filter(Boolean);
  return names.filter((name) => SANDBOX_PROCESSES.some((p) => p.toLowerCase() === name.toLowerCase()));
}

function powershell51(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', windowsHide: true });
}

/** Source commit, working-tree state, and the installer/sidecar/manifest reconciliation. */
function reconcileInstaller() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const dirtyFiles = git(['status', '--porcelain', '--untracked-files=normal', '--', ...SOURCE_PATHSPEC]).split(/\r?\n/).filter(Boolean);
  const installerPath = path.join(repoRoot, 'dist', GUEST.installerFile);
  if (!fs.existsSync(installerPath)) fail(`production installer not found: ${installerPath} (run npm run desktop:installer)`);
  const installerSha256 = sha256File(installerPath);

  const sidecarPath = `${installerPath}.sha256`;
  const manifestPath = path.join(repoRoot, 'dist', 'pandesh-installer-manifest.json');
  if (!fs.existsSync(sidecarPath)) fail(`checksum sidecar missing: ${sidecarPath}`);
  if (!fs.existsSync(manifestPath)) fail(`installer manifest missing: ${manifestPath}`);
  const sidecarSha256 = fs.readFileSync(sidecarPath, 'utf8').trim().split(/\s+/)[0].toUpperCase();
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const problems = [];
  if (sidecarSha256 !== installerSha256) problems.push(`sidecar SHA-256 ${sidecarSha256} != installer ${installerSha256}`);
  if (String(manifest.sha256).toUpperCase() !== installerSha256) problems.push(`installer manifest SHA-256 ${manifest.sha256} != installer ${installerSha256}`);
  if (manifest.bytes !== fs.statSync(installerPath).size) problems.push(`installer manifest bytes ${manifest.bytes} != ${fs.statSync(installerPath).size}`);
  if (!manifest.sourceCommit) problems.push('installer manifest has no sourceCommit (built by an older packager; rebuild with npm run desktop:installer)');
  if (manifest.sourceState !== 'clean') problems.push(`installer was built from a ${manifest.sourceState ?? 'unknown'} working tree`);
  if (manifest.sourceCommit) {
    const changed = git(['diff', '--name-only', manifest.sourceCommit, 'HEAD', '--', ...SOURCE_PATHSPEC]).split(/\r?\n/).filter(Boolean);
    if (changed.length > 0) problems.push(`source changed since the installer was built from ${manifest.sourceCommit}: ${changed.slice(0, 8).join(', ')}`);
  }
  if (dirtyFiles.length > 0) problems.push(`working tree has uncommitted source changes: ${dirtyFiles.slice(0, 8).join(', ')}`);
  return {
    head, dirtyFiles, installerPath, installerSha256, sidecarSha256, installerBytes: fs.statSync(installerPath).size,
    builtFromCommit: manifest.sourceCommit ?? null, builtFromState: manifest.sourceState ?? null, manifest, problems,
  };
}

function stage(installerPath, installerSha256) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-sandbox-'));
  const dirs = { root, installerDir: path.join(root, 'installer'), testDir: path.join(root, 'test'), resultsDir: path.join(root, 'results'), logsDir: path.join(root, 'logs') };
  for (const dir of [dirs.installerDir, dirs.testDir, dirs.resultsDir, dirs.logsDir]) fs.mkdirSync(dir, { recursive: true });

  const stagedInstaller = path.join(dirs.installerDir, GUEST.installerFile);
  fs.copyFileSync(installerPath, stagedInstaller);
  if (sha256File(stagedInstaller) !== installerSha256) fail('staged installer copy differs from dist installer');

  for (const file of ['sandbox-test.ps1', 'guest-probe.mjs', 'expected-checks.json']) {
    fs.copyFileSync(path.join(here, file), path.join(dirs.testDir, file));
  }
  return dirs;
}

function parseCheckPowerShell51(ps1Path) {
  const version = powershell51('$PSVersionTable.PSVersion.ToString()');
  const versionText = String(version.stdout).trim();
  if (version.status !== 0 || !/^5\.1\./.test(versionText)) fail(`powershell.exe is not Windows PowerShell 5.1 (reported "${versionText}")`);
  const escaped = ps1Path.replace(/'/g, "''");
  const parse = powershell51(
    `$errors = $null; $tokens = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors); `
    + 'if ($errors -and $errors.Count -gt 0) { $errors | ForEach-Object { "{0}:{1} {2}" -f $_.Extent.StartLineNumber, $_.Extent.StartColumnNumber, $_.Message }; exit 1 }',
  );
  if (parse.status !== 0) fail(`sandbox-test.ps1 does not parse in Windows PowerShell ${versionText}:\n${parse.stdout}${parse.stderr}`);
  return versionText;
}

function parseCheckXml(wsbPath) {
  const parsed = powershell51(`try { [xml]$x = Get-Content -Raw -LiteralPath '${wsbPath.replace(/'/g, "''")}'; $x.Configuration.MappedFolders.MappedFolder.Count } catch { $_.Exception.Message; exit 1 }`);
  if (parsed.status !== 0 || String(parsed.stdout).trim() !== '4') fail(`.wsb is not well-formed XML with 4 mapped folders: ${parsed.stdout}${parsed.stderr}`);
}

function killSandbox() {
  for (const image of SANDBOX_PROCESSES) spawnSync('taskkill.exe', ['/IM', image, '/F', '/T'], { stdio: 'ignore', windowsHide: true });
}

async function waitForFile(file, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return true;
    await sleep(2000);
  }
  note('timeout', `${label} did not appear within ${Math.round(timeoutMs / 1000)}s: ${file}`);
  return false;
}

async function main() {
  if (process.platform !== 'win32') fail('Windows Sandbox smoke is Windows-only');
  const startedAt = new Date().toISOString();
  const required = JSON.parse(fs.readFileSync(path.join(here, 'expected-checks.json'), 'utf8')).requiredChecks;

  const reconciliation = reconcileInstaller();
  note('source', `HEAD ${reconciliation.head}; working tree ${reconciliation.dirtyFiles.length === 0 ? 'clean' : `dirty (${reconciliation.dirtyFiles.length} files)`}`);
  note('installer', `${reconciliation.installerPath} ${reconciliation.installerBytes} bytes SHA-256 ${reconciliation.installerSha256}`);
  note('installer-build', `built from ${reconciliation.builtFromCommit} (${reconciliation.builtFromState}); sidecar ${reconciliation.sidecarSha256 === reconciliation.installerSha256 ? 'matches' : 'MISMATCH'}`);
  if (reconciliation.problems.length > 0) fail(`installer does not reconcile with the release manifest and source:\n  - ${reconciliation.problems.join('\n  - ')}`);

  const dirs = stage(reconciliation.installerPath, reconciliation.installerSha256);
  note('staged', dirs.root);
  const psVersion = parseCheckPowerShell51(path.join(dirs.testDir, 'sandbox-test.ps1'));
  note('powershell-parse', `sandbox-test.ps1 parses cleanly in Windows PowerShell ${psVersion}`);

  const wsb = generateWsb({ installerDir: dirs.installerDir, testDir: dirs.testDir, resultsDir: dirs.resultsDir, logsDir: dirs.logsDir, installerSha256: reconciliation.installerSha256 });
  const wsbPath = path.join(dirs.root, 'pandesh.wsb');
  fs.writeFileSync(wsbPath, wsb);
  const wsbProblems = [...validateWsbText(wsb), ...validateWsbHostFolders(wsb)];
  if (wsbProblems.length > 0) fail(`generated .wsb is invalid:\n  - ${wsbProblems.join('\n  - ')}`);
  parseCheckXml(wsbPath);
  note('wsb-valid', wsbPath);

  const sandboxExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsSandbox.exe');
  if (!fs.existsSync(sandboxExe)) fail('WindowsSandbox.exe not found: enable the "Windows Sandbox" optional feature');
  const already = runningSandboxProcesses();
  if (already.length > 0) fail(`a Windows Sandbox is already running (${already.join(', ')}); only one instance is allowed. Close it and retry.`);

  const evidenceRoot = path.join(repoRoot, '.acceptance-evidence', 'pandesh-sandbox-smoke', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(evidenceRoot, { recursive: true });
  const summary = { startedAt, sourceCommit: reconciliation.head, workingTreeDirty: reconciliation.dirtyFiles.length > 0, dirtyFiles: reconciliation.dirtyFiles,
    installerSha256: reconciliation.installerSha256, installerBytes: reconciliation.installerBytes, installerBuiltFromCommit: reconciliation.builtFromCommit,
    hostPowerShell: psVersion, checkOnly, timeline };

  if (checkOnly) {
    note('check-only', 'static validation passed; Windows Sandbox was not launched');
    fs.writeFileSync(path.join(evidenceRoot, 'check-only.json'), `${JSON.stringify({ ...summary, finishedAt: new Date().toISOString(), ok: true }, null, 2)}\n`);
    return 0;
  }

  // ---- real launch ----
  note('launch', `WindowsSandbox.exe ${wsbPath}`);
  const sandbox = spawn(sandboxExe, [wsbPath], { detached: true, stdio: 'ignore', windowsHide: false });
  sandbox.unref();
  sandbox.on('error', (err) => note('launch-error', err.message));

  let booted = await waitForFile(path.join(dirs.resultsDir, 'guest-started.json'), STARTUP_TIMEOUT_MS, 'guest-started.json');
  let finished = false;
  let guestStarted = null;
  if (booted) {
    guestStarted = JSON.parse(fs.readFileSync(path.join(dirs.resultsDir, 'guest-started.json'), 'utf8'));
    note('sandbox-started', `${guestStarted.windowsCaption} ${guestStarted.windowsVersion}; Windows PowerShell ${guestStarted.powershellVersion}`);
    finished = await waitForFile(path.join(dirs.resultsDir, 'guest-done.flag'), GUEST_TIMEOUT_MS, 'guest-done.flag');
    if (finished) note('guest-finished');
  }

  // The guest powers itself off; give it time, then make sure nothing is left running.
  const shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  while (runningSandboxProcesses().length > 0 && Date.now() < shutdownDeadline) await sleep(2000);
  if (runningSandboxProcesses().length > 0) { note('sandbox-forced-close', runningSandboxProcesses().join(', ')); killSandbox(); await sleep(3000); }
  else note('sandbox-closed');

  // ---- evidence and verdict ----
  const reportFile = path.join(dirs.resultsDir, 'sandbox-result.json');
  let report = null;
  let verdict;
  if (!booted) verdict = { ok: false, problems: ['Windows Sandbox did not start the guest script (no guest-started.json)'], summary: [] };
  else if (!fs.existsSync(reportFile)) verdict = { ok: false, problems: [finished ? 'guest finished without a result file' : 'guest timed out without a result file'], summary: [] };
  else {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    verdict = validateGuestReport(report, { requiredChecks: required, installerSha256: reconciliation.installerSha256 });
    if (!finished) verdict = { ...verdict, ok: false, problems: [...verdict.problems, 'guest did not signal completion'] };
  }

  fs.cpSync(dirs.resultsDir, path.join(evidenceRoot, 'results'), { recursive: true });
  fs.cpSync(dirs.logsDir, path.join(evidenceRoot, 'logs'), { recursive: true });
  const exitCode = verdict.ok ? 0 : 1;
  const finalSummary = { ...summary, finishedAt: new Date().toISOString(), guest: guestStarted, verdict, exitCode, report };
  fs.writeFileSync(path.join(evidenceRoot, 'sandbox-smoke-summary.json'), `${JSON.stringify(finalSummary, null, 2)}\n`);

  console.log('\n[sandbox-smoke] ===== per-test status =====');
  for (const check of report?.checks ?? []) console.log(`[sandbox-smoke] ${String(check.status).padEnd(4)} ${check.name} - ${check.detail}`);
  for (const check of report?.checks ?? []) if (check.evidence) console.log(`[sandbox-smoke]      evidence ${check.name}: ${String(check.evidence).slice(0, 400)}`);
  for (const problem of verdict.problems) console.log(`[sandbox-smoke] PROBLEM ${problem}`);
  console.log(`[sandbox-smoke] result: ${verdict.ok ? 'PASS' : 'FAIL'}; evidence: ${evidenceRoot}; exit code ${exitCode}`);
  return exitCode;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`[sandbox-smoke] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  killSandboxIfOurs();
}
process.exit(code);

function killSandboxIfOurs() {
  // Only reached on a harness failure after launch; a sandbox that was running before we started is never touched
  // because main() refuses to launch when one exists.
  if (timeline.some((t) => t.event === 'launch')) killSandbox();
}