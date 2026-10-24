import { pathToFileURL } from 'node:url';
import jsonEvidence from './jsonEvidence.cjs';

const { writeJsonAtomic, readJsonWithEvidence } = jsonEvidence;

/** Required acceptance exit codes are the only inputs allowed to fail CI. */
export function classifyWindowsPackagedAcceptance(input) {
  const required = {
    activationExitCode: input.activationExitCode,
    m36AttachmentRestartExitCode: input.m36AttachmentRestartExitCode,
    m36DocumentAudioRestartExitCode: input.m36DocumentAudioRestartExitCode,
    m36GovernedResearchRestartExitCode: input.m36GovernedResearchRestartExitCode,
    m36CombinedWorkbenchExitCode: input.m36CombinedWorkbenchExitCode,
    // M39 mandatory exit gate — exact-head CI cannot pass while it fails.
    m39MemoryKnowledgeRestartExitCode: input.m39MemoryKnowledgeRestartExitCode,
    mandatoryScenariosExitCode: input.mandatoryScenariosExitCode,
  };
  const acceptanceFailures = Object.entries(required)
    .filter(([, exitCode]) => exitCode !== 0)
    .map(([name, exitCode]) => ({ name, exitCode }));
  const acceptancePassed = acceptanceFailures.length === 0;
  const warmup = input.realModelWarmup ?? null;
  const realModelDiagnostics = input.realModelDiagnostics ?? [];
  const cdpReadiness = input.advisoryCdpReadiness ?? null;
  const diagnosticFailed = [warmup?.exitCode, ...realModelDiagnostics.map((diagnostic) => diagnostic?.exitCode)]
    .some((exitCode) => exitCode !== null && exitCode !== undefined && exitCode !== 0);
  const cdpTimedOut = cdpReadiness?.status === 'timed_out';

  return {
    ...input,
    status: acceptancePassed ? (diagnosticFailed || cdpTimedOut ? 'passed-with-diagnostics' : 'passed') : 'failed',
    acceptancePassed,
    acceptanceFailures,
    required,
    diagnostics: {
      realModelWarmup: warmup,
      realModelDiagnostics,
      cdpReadiness: cdpReadiness
        ? { ...cdpReadiness, acceptanceClassification: acceptancePassed ? 'advisory' : 'not-used-to-override-required-failure' }
        : null,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputIndex = process.argv.indexOf('--input');
  const outputIndex = process.argv.indexOf('--output');
  const inputPath = inputIndex === -1 ? null : process.argv[inputIndex + 1] ?? null;
  const outputPath = outputIndex === -1 ? null : process.argv[outputIndex + 1] ?? null;
  if (!inputPath || !outputPath) throw new Error('--input <path> and --output <path> are required');
  const read = readJsonWithEvidence(inputPath);
  if (!read.ok) {
    // This is harness-evidence corruption, not a product or scenario result.
    // Preserve the input and parser details in a readable output before
    // returning a distinct classifier error.
    writeJsonAtomic(outputPath, {
      status: 'classification_error',
      acceptancePassed: false,
      acceptanceFailures: [],
      classification: 'harness_json_parse_failure_not_product_failure',
      inputEvidence: read.evidence,
    });
    process.exitCode = 2;
  } else {
    writeJsonAtomic(outputPath, classifyWindowsPackagedAcceptance(read.value));
  }
}
