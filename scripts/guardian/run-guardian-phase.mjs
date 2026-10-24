import { ExTester, ReleaseQuality } from 'vscode-extension-tester';

const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing phase environment ${name}`);
  return value;
};

delete process.env.ELECTRON_RUN_AS_NODE;
const tester = new ExTester(
  required('GUARDIAN_PHASE_STORAGE'),
  ReleaseQuality.Stable,
  required('GUARDIAN_PHASE_EXTENSIONS'),
);
const exitCode = await tester.runTests(
  required('GUARDIAN_PHASE_TEST'),
  {
    vscodeVersion: required('GUARDIAN_PHASE_VSCODE_VERSION'),
    config: required('GUARDIAN_PHASE_MOCHA_CONFIG'),
    cleanup: false,
    resources: [required('GUARDIAN_WORKSPACE')],
  },
);
process.exitCode = exitCode;
