/**
 * M54-A0 Authoritative Static Architecture Guard.
 *
 * Enforces that direct production imports of child_process / node:child_process
 * are strictly restricted to an authoritative, host-reviewed allowlist.
 * Prevents future developers or autonomous agents from introducing ungoverned
 * process spawns and bypassing the security kernel.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The ONLY production files permitted to import node:child_process or child_process.
 * All paths normalized with forward slashes relative to repository root.
 */
export const AUTHORITATIVE_PROCESS_SPAWN_ALLOWLIST: ReadonlySet<string> = new Set([
  // Core authoritative executors and confinement
  'core/runtime/toolRunner.ts',
  'core/runtime/windowsShellExec.ts',
  'core/runtime/windowsConfinement.ts',
  'core/security/hardenedGit.ts',
  'core/security/safeMode.ts',
  'core/singleton/processStartTime.ts',
  'core/index.ts',
  // The shared process-ownership boundary. It only READS a process's identity
  // (one PID, read-only) and never terminates anything itself: the kill is
  // always the caller's, and only after the boundary verified ownership.
  'core/runtime/processOwnership.ts',

  // Core quarantined / platform capabilities
  'core/attachments/audioProcessing.ts',
  'core/platform/repo/workspaceHost.ts',
  'core/runtime/connectors/gwsTransport.ts',
  'core/runtime/githubCapability.ts',
  'core/runtime/browserInspection.ts',
  'core/runtime/missionLoop.ts',
  'core/runtime/missionDiffReview.ts',
  'core/runtime/missionSearch.ts',
  // Runs a planned dev story's verify argv in its Kandev worktree / KKD integration worktree (git goes via hardenedGit).
  'core/runtime/kandev/devStories.ts',
  'core/runtime/kandev/kandevClient.ts',
  'core/runtime/kandev/storyAcceptance.ts',

  // Core external engine and agent runtimes
  'core/runtime/hermesEngine.ts',
  'core/runtime/opencodeEngine.ts',
  'core/runtime/piAgentEngine.ts',

  // Extension Host sandbox / coding validation executors
  'src/sandbox/DirectProcessBackend.ts',
  'src/coding/ValidationRunner.ts',
  'src/coding/ExecutionIntegrity.ts',
  'src/coding/DiffReviewStage.ts',
  'src/coding/GeneratedArtifactPolicy.ts',
  'src/coding/GovernedCodingExecutor.ts',
  'src/coding/WorkspaceInspection.ts',
  'src/coding/WorkspaceMutation.ts',
  'src/repository/gitRunner.ts',
  'src/repository/RepoFastPath.ts',
  'src/orchestration/WorktreeManager.ts',
  'src/orchestration/LocalDeliveryService.ts',
  'src/organization/GhEngineeringIntegration.ts',
  'src/services/CommandService.ts',
  'src/validation/BaseValidationRunner.ts',
  'src/telemetry/ResourceTelemetry.ts',
  'src/workspace/GitOnboarding.ts',
  'src/workspace/WorkspaceDiscovery.ts',
  'src/roles/TrustedSequentialAgentRuntime.ts',
  'src/scrum/M18AutonomousScrum.ts',
  'src/workforce/M19AgentWorkforceRuntime.ts',
  'src/ui/AgentPanel.ts',

  // Trusted Extension Host Core launcher and diagnostics
  'src/core-client/CoreLauncher.ts',
  'src/diagnostics/SelfDiagnostics.ts',

  // Trusted workspace git context / worktree coordination
  'src/context/RepositoryContextService.ts',
  'src/context/RepositoryIndex.ts',
  'src/autonomous/M15AutonomousWork.ts',
  'src/activation/M22EngineeringOrganizationController.ts',

  // Acceptance test harnesses residing under src/
  'src/acceptance/M17DogfoodAcceptance.ts',
  'src/acceptance/M17GitHubDeliveryDogfood.ts',
]);

const CHILD_PROCESS_IMPORT_PATTERN = /(?:from\s+['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\)|import\(['"](?:node:)?child_process['"]\))/;

export interface ArchitectureViolation {
  filePath: string;
  matchedLine: string;
  lineNumber: number;
}

export function auditRepositoryArchitecture(repoRoot: string = process.cwd()): {
  ok: boolean;
  passed: boolean;
  violations: readonly ArchitectureViolation[];
} {
  const violations: ArchitectureViolation[] = [];
  const scannedDirs = ['core', 'src'];

  function walkDir(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip tests, fixtures, and node_modules
        if (
          entry.name === 'test' ||
          entry.name === 'tests' ||
          entry.name === 'fixtures' ||
          entry.name === 'node_modules' ||
          entry.name === 'ui-test'
        ) {
          continue;
        }
        walkDir(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        // Skip test files
        if (
          entry.name.endsWith('.test.ts') ||
          entry.name.endsWith('.spec.ts') ||
          entry.name.endsWith('.test.js')
        ) {
          continue;
        }

        const relativePath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
        const content = fs.readFileSync(fullPath, 'utf8');

        if (CHILD_PROCESS_IMPORT_PATTERN.test(content)) {
          if (!AUTHORITATIVE_PROCESS_SPAWN_ALLOWLIST.has(relativePath)) {
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (CHILD_PROCESS_IMPORT_PATTERN.test(lines[i])) {
                violations.push({
                  filePath: relativePath,
                  matchedLine: lines[i].trim(),
                  lineNumber: i + 1,
                });
              }
            }
          }
        }
      }
    }
  }

  for (const dir of scannedDirs) {
    const target = path.join(repoRoot, dir);
    if (fs.existsSync(target)) {
      walkDir(target);
    }
  }

  return {
    ok: violations.length === 0,
    passed: violations.length === 0,
    violations,
  };
}

export const checkArchitectureGuard = auditRepositoryArchitecture;
