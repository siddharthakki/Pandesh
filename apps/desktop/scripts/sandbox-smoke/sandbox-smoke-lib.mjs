/**
 * Pure helpers for the Windows Sandbox smoke test: .wsb generation and validation, and acceptance of the guest
 * report. Kept free of side effects so they can be unit-tested without launching Windows Sandbox.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export const GUEST = {
  installerDir: 'C:\\Sandbox\\Installer',
  testDir: 'C:\\Sandbox\\Test',
  resultsDir: 'C:\\Sandbox\\Results',
  logsDir: 'C:\\Sandbox\\Logs',
  installerFile: 'Pandesh-Setup.exe',
};

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * @param {{installerDir: string, testDir: string, resultsDir: string, logsDir: string, installerSha256: string, memoryMb?: number}} input
 * Each host path must be an existing directory (Windows Sandbox rejects a file as <HostFolder>).
 */
export function generateWsb(input) {
  const folder = (host, guest, readOnly) => [
    '    <MappedFolder>',
    `      <HostFolder>${escapeXml(path.resolve(host))}</HostFolder>`,
    `      <SandboxFolder>${escapeXml(guest)}</SandboxFolder>`,
    `      <ReadOnly>${readOnly ? 'true' : 'false'}</ReadOnly>`,
    '    </MappedFolder>',
  ].join('\n');
  const command = [
    'cmd.exe /c "reg add HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy /v VerifiedAndReputablePolicyState /t REG_DWORD /d 0 /f & CiTool.exe -r & powershell.exe -NoProfile -ExecutionPolicy Bypass',
    `-File ${GUEST.testDir}\\sandbox-test.ps1`,
    `-InstallerPath ${GUEST.installerDir}\\${GUEST.installerFile}`,
    `-ExpectedInstallerSha256 ${input.installerSha256}`,
    `-ExpectedChecksPath ${GUEST.testDir}\\expected-checks.json`,
    `-ProbePath ${GUEST.testDir}\\guest-probe.mjs`,
    `-ResultsPath ${GUEST.resultsDir}`,
    `-LogsPath ${GUEST.logsDir}"`,
  ].join(' ');
  return [
    '<Configuration>',
    '  <VGpu>Disable</VGpu>',
    '  <Networking>Disable</Networking>',
    `  <MemoryInMB>${input.memoryMb ?? 6144}</MemoryInMB>`,
    '  <AudioInput>Disable</AudioInput>',
    '  <VideoInput>Disable</VideoInput>',
    '  <PrinterRedirection>Disable</PrinterRedirection>',
    '  <ClipboardRedirection>Disable</ClipboardRedirection>',
    '  <MappedFolders>',
    folder(input.installerDir, GUEST.installerDir, true),
    folder(input.testDir, GUEST.testDir, true),
    folder(input.resultsDir, GUEST.resultsDir, false),
    folder(input.logsDir, GUEST.logsDir, false),
    '  </MappedFolders>',
    '  <LogonCommand>',
    `    <Command>${escapeXml(command)}</Command>`,
    '  </LogonCommand>',
    '</Configuration>',
    '',
  ].join('\n');
}

const ALLOWED_TOP_LEVEL = new Set(['VGpu', 'Networking', 'MemoryInMB', 'AudioInput', 'VideoInput', 'PrinterRedirection', 'ClipboardRedirection', 'ProtectedClient', 'MappedFolders', 'LogonCommand']);

/**
 * Structural validation of generated .wsb text. Returns a list of problems (empty when valid). Well-formedness is
 * additionally proven by the host with a real XML parser (see sandbox-smoke.mjs).
 */
export function validateWsbText(xml) {
  const problems = [];
  const topLevel = [...xml.matchAll(/^ {2}<([A-Za-z]+)>/gm)].map((m) => m[1]);
  for (const name of topLevel) if (!ALLOWED_TOP_LEVEL.has(name)) problems.push(`unknown <Configuration> child <${name}>`);
  const folders = [...xml.matchAll(/<MappedFolder>\s*<HostFolder>([^<]*)<\/HostFolder>\s*<SandboxFolder>([^<]*)<\/SandboxFolder>\s*<ReadOnly>(true|false)<\/ReadOnly>\s*<\/MappedFolder>/g)];
  if (folders.length !== 4) problems.push(`expected 4 mapped folders, found ${folders.length}`);
  for (const [, hostRaw, guestRaw, readOnly] of folders) {
    const host = hostRaw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const guest = guestRaw.replace(/&amp;/g, '&');
    if (!path.win32.isAbsolute(host)) problems.push(`HostFolder is not absolute: ${host}`);
    if (/\\\\/.test(host.slice(2))) problems.push(`HostFolder contains a doubled backslash: ${host}`);
    if (!path.win32.isAbsolute(guest)) problems.push(`SandboxFolder is not absolute: ${guest}`);
    if (/\.[A-Za-z0-9]{2,4}$/.test(host)) problems.push(`HostFolder looks like a file, not a directory: ${host}`);
    if ((guest === GUEST.installerDir || guest === GUEST.testDir) && readOnly !== 'true') problems.push(`${guest} must be read-only`);
  }
  if (!/<Networking>Disable<\/Networking>/.test(xml)) problems.push('networking must be disabled');
  if (!/<LogonCommand>\s*<Command>[^<]+<\/Command>\s*<\/LogonCommand>/.test(xml)) problems.push('missing LogonCommand');
  return problems;
}

/** Filesystem validation of every mapped host folder. */
export function validateWsbHostFolders(xml) {
  const problems = [];
  for (const [, hostRaw, guestRaw] of xml.matchAll(/<HostFolder>([^<]*)<\/HostFolder>\s*<SandboxFolder>([^<]*)<\/SandboxFolder>/g)) {
    const host = hostRaw.replace(/&amp;/g, '&');
    if (!fs.existsSync(host)) { problems.push(`HostFolder does not exist: ${host}`); continue; }
    if (!fs.statSync(host).isDirectory()) { problems.push(`HostFolder is not a directory: ${host}`); continue; }
    if (guestRaw === GUEST.installerDir) {
      const entries = fs.readdirSync(host);
      if (entries.length !== 1 || entries[0] !== GUEST.installerFile) problems.push(`installer folder must contain only ${GUEST.installerFile}, found: ${entries.join(', ')}`);
    }
  }
  return problems;
}

/**
 * Decides whether a guest report may be accepted. Independent of the guest's own "ok" field.
 * @returns {{ok: boolean, problems: string[], summary: Array<{name: string, status: string}>}}
 */
export function validateGuestReport(report, { requiredChecks, installerSha256 }) {
  const problems = [];
  if (!report || typeof report !== 'object') return { ok: false, problems: ['report is not an object'], summary: [] };
  const checks = Array.isArray(report.checks) ? report.checks : [];
  for (const name of requiredChecks) {
    const matches = checks.filter((c) => c?.name === name);
    if (matches.length === 0) problems.push(`required check missing: ${name}`);
    else if (matches.length > 1) problems.push(`required check reported ${matches.length} times: ${name}`);
    else if (matches[0].status !== 'PASS') problems.push(`${name} is ${matches[0].status}: ${matches[0].detail ?? ''}`);
  }
  for (const check of checks) {
    if (!requiredChecks.includes(check?.name)) problems.push(`unexpected check in report: ${check?.name} (${check?.status})`);
    if (check?.status === 'SKIP') problems.push(`SKIP is not accepted: ${check?.name}`);
  }
  if (!/^5\.1\./.test(String(report.environment?.powershellVersion ?? ''))) {
    problems.push(`guest did not run Windows PowerShell 5.1 (reported ${report.environment?.powershellVersion})`);
  }
  if (String(report.evidence?.installerSha256 ?? '').toUpperCase() !== installerSha256.toUpperCase()) {
    problems.push('guest-measured installer SHA-256 differs from the host measurement');
  }
  if (report.ok !== true) problems.push('guest verdict is not ok');
  return { ok: problems.length === 0, problems, summary: checks.map((c) => ({ name: String(c?.name), status: String(c?.status) })) };
}
