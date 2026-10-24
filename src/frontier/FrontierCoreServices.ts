import * as path from 'path';
import { FileAutomationStorage } from '../automation/AutomationStorage';
import { JobCoordinator, JobCoordinatorOptions } from '../automation/JobCoordinator';
import { BrowserDriver, BrowserVerificationRunner } from '../browser/BrowserVerification';
import { ImprovementRegistry } from '../evals/ImprovementRegistry';
import { FrontierContextComposer } from '../intelligence/FrontierContextComposer';
import { KnowledgeLedger, KnowledgeLedgerOptions } from '../memory/KnowledgeLedger';
import { FileMemoryStorage } from '../memory/MemoryStorage';
import { AdaptivePlanner } from '../planning/AdaptivePlanner';
import { EventCorrelation } from '../reliability/EventCorrelation';
import { ReviewWorkflow } from '../review/ReviewWorkflow';
import { AgentTeamCoordinator, AgentTeamCoordinatorOptions } from '../teams/AgentTeamCoordinator';

export class FrontierCoreServices {
  readonly eventCorrelation = new EventCorrelation();
  readonly improvements = new ImprovementRegistry();

  constructor(
    private readonly workspaceRoot: string,
    readonly context: FrontierContextComposer,
  ) {}

  createTeam(options: AgentTeamCoordinatorOptions = {}): AgentTeamCoordinator {
    return new AgentTeamCoordinator(options);
  }

  createPlanner(): AdaptivePlanner {
    return new AdaptivePlanner();
  }

  createJobs(options: Omit<JobCoordinatorOptions, 'storage'> = {}): JobCoordinator {
    return new JobCoordinator({
      ...options,
      storage: new FileAutomationStorage(
        path.join(this.workspaceRoot, '.ollama-agent', 'frontier', 'automations'),
      ),
    });
  }

  createReview(diff: string, sessionId?: string): ReviewWorkflow {
    return new ReviewWorkflow(diff, sessionId);
  }

  createBrowserVerification(driver: BrowserDriver): BrowserVerificationRunner {
    return new BrowserVerificationRunner(driver);
  }

  async openKnowledgeLedger(
    options: Omit<KnowledgeLedgerOptions, 'storage'>,
  ): Promise<KnowledgeLedger> {
    const ledger = new KnowledgeLedger({
      ...options,
      storage: new FileMemoryStorage(
        path.join(this.workspaceRoot, '.ollama-agent', 'frontier', 'memory.json'),
      ),
    });
    await ledger.initialize();
    return ledger;
  }
}
