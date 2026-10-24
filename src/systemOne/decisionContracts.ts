import type { KkdMode } from './SystemOneDecisionService';
import type { SystemOneDecisionType, SystemOneQuestion } from './types';

/**
 * Named decision contracts. Only `intent` and `follow_up` are actually sent
 * to a provider today (carried over from the original Laya shadow advisor).
 * `mutation_required`, `scope_change` and `new_objective` are foundation for
 * later milestones — defined so routing code and providers agree on a shape
 * in advance, but nothing constructs a request for them yet.
 *
 * `same_context` is deliberately not a decision type here: the current
 * benchmark for it is bad (2/12) and it must not become authoritative.
 */
export const DECISION_CONTRACTS: Record<SystemOneDecisionType, SystemOneQuestion> = {
  intent: {
    type: 'choice',
    instructions: 'What does the user want KarkeDikha to do with their latest message?',
    criteria: {
      chat: 'Just talk: answer, explain or acknowledge; do not change any files.',
      bounded_edit: 'Make a small, specific change to the existing code or app.',
      autonomous_request: 'Build or deliver a whole feature or project end to end.',
    },
  },
  follow_up: {
    type: 'choice',
    instructions: 'What kind of follow-up is the latest user message?',
    criteria: {
      acknowledgement: 'A simple acknowledgement or thanks.',
      explanation: 'Asks the assistant to explain or justify something it said or did.',
      mutation: 'Asks for a change to be made or approves a proposed change.',
      new_topic: 'Starts an unrelated new topic.',
    },
  },
  mutation_required: {
    type: 'choice',
    instructions: 'Does satisfying the latest user message require changing any file or running any action?',
    criteria: {
      yes: 'Some file, config, or external state must change.',
      no: 'A response in words is enough; nothing needs to change.',
    },
  },
  scope_change: {
    type: 'choice',
    instructions: 'Does the latest user message change the scope of the task already in progress?',
    criteria: {
      none: 'Continues the current task with no change in scope.',
      narrow: 'Narrows or clarifies the current task.',
      expand: 'Expands the current task to cover more than before.',
      replace: 'Replaces the current task with a different one.',
    },
  },
  new_objective: {
    type: 'choice',
    instructions: 'Does the latest user message introduce a new objective unrelated to any task in progress?',
    criteria: {
      yes: 'This is a new objective, not a continuation of anything in progress.',
      no: 'This continues or relates to an objective already in progress.',
    },
  },
};

/** Decision types actually wired into a live provider call in this milestone. */
export const ACTIVE_DECISION_TYPES: SystemOneDecisionType[] = ['intent', 'follow_up'];

export const INTENT_TO_MODE: Record<string, KkdMode> = {
  chat: 'chat',
  bounded_edit: 'agent',
  autonomous_request: 'autonomous',
};
