import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { Config } from '../config/Config';
import { RepositoryContextService } from '../context/RepositoryContextService';
import { planRepositoryContextBudgetForModel } from '../context/RepositoryContextBudget';
import { ContextRole } from '../context/RepositoryTypes';
import { ProviderGateway } from '../providers/ProviderGateway';
import { ModelDispatchPlanner } from '../reliability/ModelDispatchPlanner';
import { ChatMessage } from '../tools/ToolTypes';
import { rolePrompt } from './RolePrompts';
import {
  PlanStep,
  PlannerArtifact,
  ReviewArtifact,
  ReviewFinding,
  SpecialistRole,
  SupervisorArtifact,
  ValidationArtifact,
} from './RoleTypes';

function nowIso(): string {
  return new Date().toISOString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
    : [];
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return objectValue(JSON.parse(withoutFence));
  } catch {
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return objectValue(JSON.parse(withoutFence.slice(start, end + 1))); } catch { /* fallback below */ }
    }
    return {};
  }
}

export class RoleRunner {
  private readonly contextService: RepositoryContextService;

  constructor(
    private readonly workspaceRoot: string,
    private readonly secrets: vscode.SecretStorage,
  ) {
    this.contextService = new RepositoryContextService(workspaceRoot);
  }

  async runSupervisor(
    goal: string,
    contractSummary: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<SupervisorArtifact> {
    const model = Config.getAgentModel();
    const response = await this.runJson(
      'supervisor',
      'general',
      goal,
      { goal, contract: contractSummary },
      model,
      signal,
    );
    return {
      schemaVersion: 1,
      role: 'supervisor',
      goal,
      taskSummary: stringValue(response.parsed['taskSummary'], goal),
      acceptanceCriteria: stringArray(response.parsed['acceptanceCriteria']),
      risks: stringArray(response.parsed['risks']),
      allowedPaths: stringArray(response.parsed['allowedPaths']),
      recommendedValidation: stringArray(response.parsed['recommendedValidation']),
      createdAt: nowIso(),
      model,
      rawResponse: response.raw,
    };
  }

  async runPlanner(
    goal: string,
    supervisor: SupervisorArtifact,
    signal?: AbortSignal,
  ): Promise<PlannerArtifact> {
    const model = Config.getAgentModel();
    const response = await this.runJson(
      'planner',
      'planner',
      goal,
      { goal, supervisor },
      model,
      signal,
    );
    const rawSteps = Array.isArray(response.parsed['steps']) ? response.parsed['steps'] : [];
    const steps: PlanStep[] = rawSteps.map((value, index) => {
      const item = objectValue(value);
      return {
        id: stringValue(item['id'], `step-${index + 1}`),
        objective: stringValue(item['objective'], 'Inspect and implement the scoped change.'),
        files: stringArray(item['files']),
        validation: stringArray(item['validation']),
      };
    });
    return {
      schemaVersion: 1,
      role: 'planner',
      goal,
      summary: stringValue(response.parsed['summary'], 'Execute the approved task in bounded steps.'),
      steps: steps.length > 0 ? steps : [{
        id: 'step-1',
        objective: 'Inspect, implement, and validate the requested change.',
        files: supervisor.allowedPaths,
        validation: supervisor.recommendedValidation,
      }],
      assumptions: stringArray(response.parsed['assumptions']),
      createdAt: nowIso(),
      model,
      rawResponse: response.raw,
    };
  }

  async runReviewer(
    taskId: string,
    goal: string,
    planner: PlannerArtifact,
    implementation: Record<string, unknown>,
    gitEvidence: string,
    signal?: AbortSignal,
  ): Promise<ReviewArtifact> {
    const model = Config.getReviewerModel();
    const response = await this.runJson(
      'reviewer',
      'reviewer',
      goal,
      { goal, planner, implementation, gitEvidence },
      model,
      signal,
    );
    const findings = this.reviewFindings(response.parsed['findings']);
    const blocking = booleanValue(
      response.parsed['blocking'],
      findings.some(finding => finding.severity === 'blocking'),
    );
    return {
      schemaVersion: 1,
      role: 'reviewer',
      taskId,
      summary: stringValue(response.parsed['summary'], blocking ? 'Blocking review findings remain.' : 'No blocking review findings.'),
      blocking,
      findings,
      reviewedAt: nowIso(),
      model,
      rawResponse: response.raw,
    };
  }

  async runValidator(
    taskId: string,
    goal: string,
    implementation: Record<string, unknown>,
    review: ReviewArtifact,
    mechanicalValidation: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ValidationArtifact> {
    const model = Config.getReviewerModel();
    const response = await this.runJson(
      'validator',
      'validator',
      goal,
      { goal, implementation, review, mechanicalValidation },
      model,
      signal,
    );
    const mechanicalPassed = booleanValue(mechanicalValidation['success'], false)
      || booleanValue(objectValue(mechanicalValidation['validation'])['requiredPassed'], false);
    const requiredGatesPassed = booleanValue(response.parsed['requiredGatesPassed'], mechanicalPassed);
    const reviewerBlocking = booleanValue(response.parsed['reviewerBlocking'], review.blocking);
    return {
      schemaVersion: 1,
      role: 'validator',
      taskId,
      passed: booleanValue(response.parsed['passed'], requiredGatesPassed && !reviewerBlocking)
        && requiredGatesPassed
        && !reviewerBlocking,
      summary: stringValue(response.parsed['summary'], requiredGatesPassed && !reviewerBlocking
        ? 'Mechanical validation and review support completion.'
        : 'Completion evidence is insufficient.'),
      requiredGatesPassed,
      reviewerBlocking,
      commandsRun: stringArray(response.parsed['commandsRun']).length > 0
        ? stringArray(response.parsed['commandsRun'])
        : stringArray(mechanicalValidation['commandsRun']),
      validatedAt: nowIso(),
      model,
      rawResponse: response.raw,
    };
  }

  async writeArtifact(taskDir: string, filename: string, value: unknown): Promise<void> {
    await fs.mkdir(taskDir, { recursive: true });
    const destination = path.join(taskDir, filename);
    const temporary = `${destination}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(temporary, destination);
  }

  private async runJson(
    role: SpecialistRole,
    contextRole: ContextRole,
    goal: string,
    payload: Record<string, unknown>,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ parsed: Record<string, unknown>; raw: string }> {
    let repositoryContext = '';
    try {
      const budget = planRepositoryContextBudgetForModel({
        model,
        providerType: Config.getProviderType(),
        objective: `${goal}
${JSON.stringify(payload)}`,
        maxOutputTokens: Config.getMaxOutputTokens() || undefined,
      });
      const selected = await this.contextService.build({
        query: goal,
        mode: role === 'planner' ? 'plan' : role === 'reviewer' || role === 'validator' ? 'ask' : 'agent',
        role: contextRole,
        model,
        providerType: Config.getProviderType(),
        tokenBudget: budget.budgetTokens,
        budget,
      });
      repositoryContext = selected.prompt;
    } catch {
      repositoryContext = '';
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: rolePrompt(role) },
      {
        role: 'user',
        content: [
          `Goal:\n${goal}`,
          `Role input:\n${JSON.stringify(payload, null, 2)}`,
          repositoryContext,
        ].filter(Boolean).join('\n\n'),
      },
    ];
    const provider = await ProviderGateway.create(this.secrets);
    // Shared M11 preflight: same profile/context/limit/options resolution as
    // AgentLoop and governed Forge execution. Oversized role prompts are
    // blocked before the provider is invoked.
    const session = await ModelDispatchPlanner.createSession({
      model,
      provider,
      toolsActive: false,
      hasImages: false,
      signal,
    });
    const preflight = session.preflight(messages, []);
    if (!preflight.ok) {
      throw new Error(preflight.reason ?? 'Role model request blocked by context preflight before dispatch.');
    }
    const response = await provider.chat(messages, [], session.options, signal);
    const raw = response.message.content ?? '';
    return { parsed: parseJsonObject(raw), raw };
  }

  private reviewFindings(value: unknown): ReviewFinding[] {
    if (!Array.isArray(value)) { return []; }
    return value.map(item => {
      const finding = objectValue(item);
      const severity = stringValue(finding['severity'], 'info');
      return {
        severity: severity === 'blocking' || severity === 'warning' ? severity : 'info',
        file: stringValue(finding['file']) || undefined,
        message: stringValue(finding['message'], 'Unspecified review finding.'),
        remediation: stringValue(finding['remediation']) || undefined,
      };
    });
  }
}
