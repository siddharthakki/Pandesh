import * as path from 'path';
import {
  FrontierAcceptanceBenchmark,
  FrontierScenario,
  FrontierThresholds,
} from '../acceptance/FrontierAcceptance';
import { EnterpriseGovernance, OrganizationPolicy } from '../governance/EnterpriseGovernance';
import { MultiRepositoryPlanner } from '../multirepo/MultiRepositoryPlanner';
import { ProviderScheduler } from '../orchestration/ProviderScheduler';
import { ComputeAwareProviderRouter } from '../performance/ComputeAwareProviderRouter';
import { ComputeScheduler } from '../performance/ComputeScheduler';
import { PromptCache, PromptCacheOptions } from '../performance/PromptCache';
import { FileRemoteTaskStorage } from '../remote/FileRemoteTaskStorage';
import { RemoteTaskService } from '../remote/RemoteTaskService';
import { ReleaseChannelManager, ReleaseSigner } from '../release/ReleaseChannelManager';
import { ArtifactPolicy, ArtifactTrustPolicy } from '../security/ArtifactPolicy';
import { SbomGenerator } from '../security/SbomGenerator';
import {
  DependencyInspector,
  SecurityScanner,
  SecurityScannerOptions,
} from '../security/SecurityScanner';

export class ProductScaleServices {
  constructor(private readonly workspaceRoot: string) {}

  createArtifactPolicy(policy: ArtifactTrustPolicy): ArtifactPolicy {
    return new ArtifactPolicy(policy);
  }

  createSecurityScanner(
    dependencyInspector?: DependencyInspector,
    options: SecurityScannerOptions = {},
  ): SecurityScanner {
    return new SecurityScanner(this.workspaceRoot, dependencyInspector, options);
  }

  createSbomGenerator(): SbomGenerator {
    return new SbomGenerator(this.workspaceRoot);
  }

  createComputeScheduler(): ComputeScheduler {
    return new ComputeScheduler();
  }

  createComputeAwareProviderRouter(
    providers: ProviderScheduler,
    compute: ComputeScheduler = new ComputeScheduler(),
  ): ComputeAwareProviderRouter {
    return new ComputeAwareProviderRouter(providers, compute);
  }

  createPromptCache<T>(options: PromptCacheOptions = {}): PromptCache<T> {
    return new PromptCache<T>(options);
  }

  async openRemoteTasks(): Promise<RemoteTaskService> {
    const service = new RemoteTaskService(
      new FileRemoteTaskStorage(
        path.join(this.workspaceRoot, '.ollama-agent', 'frontier', 'remote-tasks.json'),
      ),
    );
    await service.initialize();
    return service;
  }

  createMultiRepositoryPlanner(): MultiRepositoryPlanner {
    return new MultiRepositoryPlanner();
  }

  createGovernance(policy: OrganizationPolicy): EnterpriseGovernance {
    return new EnterpriseGovernance(policy);
  }

  createReleaseChannels(signer: ReleaseSigner): ReleaseChannelManager {
    return new ReleaseChannelManager(signer);
  }

  createAcceptanceBenchmark(
    scenarios: readonly FrontierScenario[],
    thresholds: FrontierThresholds,
  ): FrontierAcceptanceBenchmark {
    return new FrontierAcceptanceBenchmark(scenarios, thresholds);
  }
}
