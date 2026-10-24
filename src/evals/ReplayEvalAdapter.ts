import { EvalAdapter, EvalExecutionContext, EvalObservation } from './EvalTypes';

export type EvalObservationInput = Omit<EvalObservation, 'scenarioId'> & { scenarioId?: string };

export class ReplayEvalAdapter implements EvalAdapter {
  private readonly observations: Map<string, EvalObservationInput>;

  constructor(observations: Record<string, EvalObservationInput> | EvalObservationInput[]) {
    if (Array.isArray(observations)) {
      this.observations = new Map(observations
        .filter(item => Boolean(item.scenarioId))
        .map(item => [item.scenarioId as string, item]));
    } else {
      this.observations = new Map(Object.entries(observations));
    }
  }

  async execute(context: EvalExecutionContext): Promise<EvalObservation> {
    const observation = this.observations.get(context.scenario.id);
    if (!observation) {
      throw new Error(`No recorded observation for scenario ${context.scenario.id}`);
    }
    return {
      ...observation,
      scenarioId: context.scenario.id,
      changedFiles: [...observation.changedFiles],
      incorrectFilesChanged: [...observation.incorrectFilesChanged],
      contextFiles: observation.contextFiles ? [...observation.contextFiles] : undefined,
      contextRelevantFiles: observation.contextRelevantFiles
        ? [...observation.contextRelevantFiles]
        : undefined,
      evidence: { ...observation.evidence },
    };
  }
}
