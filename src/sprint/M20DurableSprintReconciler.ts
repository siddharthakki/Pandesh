import type { AutonomousTask } from '../autonomous/M15AutonomousWork';
import { JsonSprintStore, defaultM20SprintStatePath } from './M20AutonomousSprint';
import type { SprintStoryState } from './M20AutonomousSprint';

export interface DurableSprintTaskBinding {
  sprintId?: string;
  storyId: string;
  taskId?: string;
  state?: string;
}

export interface DurableSprintReconcileResult {
  updatedStoryIds: string[];
}

export async function reconcileSprintFromDurableTasks(
  repositoryRoot: string,
  activeSprintId: string | undefined,
  bindings: readonly DurableSprintTaskBinding[],
  tasks: readonly AutonomousTask[],
  now: () => Date = () => new Date(),
): Promise<DurableSprintReconcileResult> {
  if (!activeSprintId) return { updatedStoryIds: [] };
  const store = new JsonSprintStore(defaultM20SprintStatePath(repositoryRoot));
  const state = await store.load();
  const sprint = state.sprints.find(value => value.id === activeSprintId);
  if (!sprint) return { updatedStoryIds: [] };

  const byTaskId = new Map(tasks.map(task => [task.taskId, task]));
  const updatedStoryIds: string[] = [];
  for (const binding of bindings) {
    if (binding.sprintId !== activeSprintId || !binding.taskId) continue;
    const story = state.stories.find(value => value.id === binding.storyId);
    const task = byTaskId.get(binding.taskId);
    if (!story || !task) continue;
    const next: SprintStoryState = binding.state === 'done' ? 'done' : mapTaskToStoryState(task);
    const progress = next === 'done' ? 100
      : next === 'review' ? 90
      : next === 'in-progress' ? Math.max(story.progress, 25)
      : story.progress;
    const changed = story.state !== next || story.progress !== progress;
    story.state = next;
    story.progress = progress;
    story.blockedReason = next === 'blocked' ? task.failure?.message ?? task.validationFailure?.stdoutStderrTail ?? 'Autonomous task blocked.' : undefined;
    story.blockedAt = next === 'blocked' ? task.failure?.at ?? now().toISOString() : undefined;
    story.completedAt = next === 'done' ? story.completedAt ?? now().toISOString() : undefined;
    if (changed) {
      state.events.push({
        id: `durable-${task.taskId}-${task.attemptId}-${next}`,
        at: now().toISOString(),
        type: next === 'done' ? 'completed' : next === 'blocked' ? 'blocked' : next === 'review' ? 'review' : 'progress',
        storyId: story.id,
        summary: `Recovered ${story.title} from durable task ${task.taskId}: ${next}.`,
      });
      updatedStoryIds.push(story.id);
    }
  }

  if (sprint.storyIds.every(id => {
    const story = state.stories.find(value => value.id === id);
    return story?.state === 'done' || story?.state === 'blocked' || story?.state === 'cancelled';
  })) {
    sprint.status = 'review';
  }
  if (updatedStoryIds.length > 0) await store.save(state);
  return { updatedStoryIds };
}

function mapTaskToStoryState(task: AutonomousTask): SprintStoryState {
  if (task.state === 'completed') {
    return task.githubDelivery.pullRequestUrl ? 'review' : 'done';
  }
  if (task.state === 'failed' || task.state === 'blocked' || task.state === 'cancelled') return 'blocked';
  if (task.state === 'waiting_for_review' || task.state === 'monitoring_ci' || task.githubDelivery.pullRequestUrl) return 'review';
  if (task.state === 'queued' || task.state === 'scheduled' || task.state === 'waiting_for_resources') return 'assigned';
  return 'in-progress';
}
