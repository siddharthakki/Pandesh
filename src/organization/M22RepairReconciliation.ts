import {
  JsonM22OrganizationStore,
  defaultM22OrganizationStatePath,
} from './M22SelfDogfoodOrganization';
import type { RepairBugRecord } from '../repair/M21CIBugRepairLoop';

export interface AdoptRepairResult {
  adopted: boolean;
  issueNumber?: number;
  previousPullRequestUrl?: string;
  repairPullRequestUrl?: string;
}

export async function adoptVerifiedRepairDelivery(
  repositoryRoot: string,
  repository: string,
  bug: RepairBugRecord,
  now: () => Date = () => new Date(),
): Promise<AdoptRepairResult> {
  if (bug.state !== 'verified' || !bug.sourceIssueNumber || !bug.repairTaskId || !bug.repairPullRequestUrl) {
    return { adopted: false };
  }
  const store = new JsonM22OrganizationStore(defaultM22OrganizationStatePath(repositoryRoot));
  const state = await store.load(repository);
  const binding = state.bindings.find(value => value.issueNumber === bug.sourceIssueNumber && value.state !== 'done');
  if (!binding) return { adopted: false, issueNumber: bug.sourceIssueNumber };
  const previousPullRequestUrl = binding.pullRequestUrl;
  binding.taskId = bug.repairTaskId;
  binding.pullRequestUrl = bug.repairPullRequestUrl;
  binding.state = 'review';
  binding.updatedAt = now().toISOString();
  state.updatedAt = now().toISOString();
  await store.save(state);
  return {
    adopted: true,
    issueNumber: bug.sourceIssueNumber,
    previousPullRequestUrl,
    repairPullRequestUrl: bug.repairPullRequestUrl,
  };
}
