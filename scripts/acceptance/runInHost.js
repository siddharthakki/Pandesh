'use strict';

// lower_level_executor_smoke — the ONLY scenario still run through
// @vscode/test-electron's runTests()/--extensionTestsPath.
//
// This is NOT packaged autonomous acceptance. It never invokes any
// vscode.window modal or QuickPick API (Checkpoint C's root cause is that
// the extension-test host's DialogService refuses to render any modal at
// all, so any scenario exercising a real Approve/Reject surface must run
// through scripts/acceptance/plainVsCodeHost.mjs instead — see
// run-packaged-acceptance.mjs). It calls GovernedCodingExecutor directly with
// auto-approving callbacks, purely to smoke-test the packaged compiled
// output loads and executes in a real Extension Development Host.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');

const EXTENSION_ID = 'ollama-agent.ollama-agent';
const RUN_DIAGNOSTICS_COMMAND = 'ollama-agent.runDiagnostics';

function fakeSecretStorage() {
  const store = new Map();
  return {
    get: async key => store.get(key),
    store: async (key, value) => { store.set(key, value); },
    delete: async key => { store.delete(key); },
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

async function run() {
  const evidenceDir = process.env.OLLAMA_AGENT_ACCEPTANCE_EVIDENCE_DIR;
  const evidence = { scenario: 'lower_level_executor_smoke', steps: [] };
  const record = (name, detail) => evidence.steps.push({ name, detail, at: new Date().toISOString() });

  try {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `packaged extension "${EXTENSION_ID}" was not found by the Extension Development Host`);
    await extension.activate();
    record('activation', 'packaged VSIX activated in a real Extension Development Host');

    const workspaceFolders = vscode.workspace.workspaceFolders;
    assert.ok(workspaceFolders && workspaceFolders.length > 0, 'no disposable workspace folder was opened');
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    const { GovernedCodingExecutor } = require(
      path.join(extension.extensionPath, 'out', 'coding', 'GovernedCodingExecutor.js'),
    );
    const { ForgeExecutionReadiness } = require(
      path.join(extension.extensionPath, 'out', 'coding', 'ExecutionIntegrity.js'),
    );
    const readiness = new ForgeExecutionReadiness(workspaceRoot, {
      workspaceFolders,
      trusted: vscode.workspace.isTrusted,
      dirtyDocuments: [],
      extensionBuild: extension.packageJSON.version,
    });

    const executor = new GovernedCodingExecutor();
    const controller = new AbortController();

    const result = await executor.execute({
      runId: `packaged_acceptance_${Date.now()}`,
      goal: 'create the packaged acceptance file',
      workspaceRoot,
      signal: controller.signal,
      secrets: fakeSecretStorage(),
      auditSource: 'packaged-vsix-acceptance-harness',
      extensionBuild: extension.packageJSON.version,
      callbacks: {
        checkReadiness: async targetPaths => readiness.check(targetPaths ?? []),
        reviewProposal: async () => true,
        approveExecution: async () => true,
        confirmElevated: async () => true,
      },
    });
    record('governed-coding-execution', `status=${result.status} failureReason=${result.failureReason ?? ''}`);
    assert.strictEqual(
      result.status,
      'completed',
      `expected governed coding execution to complete, got "${result.status}" (${result.failureReason ?? 'no failure reason'}); validations=${JSON.stringify(result.validations)}`,
    );

    const producedFile = path.join(workspaceRoot, 'src', 'generated', 'packagedAcceptance.ts');
    assert.ok(fs.existsSync(producedFile), `expected mutation output missing: ${producedFile}`);
    const content = fs.readFileSync(producedFile, 'utf8');
    assert.ok(content.includes('packagedAcceptance'), 'mutation output did not contain expected content');
    record('mutation-verified', producedFile);

    await vscode.commands.executeCommand(RUN_DIAGNOSTICS_COMMAND);
    record('diagnostics', 'ran RUN_DIAGNOSTICS_COMMAND without throwing');

    evidence.status = 'passed';
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
    throw error;
  } finally {
    if (evidenceDir) {
      fs.mkdirSync(evidenceDir, { recursive: true });
      fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2));
    }
  }
}

module.exports = { run };
