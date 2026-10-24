/**
 * P0 — Machine-control tool authorization.
 *
 * Some governed tools change the state of the MACHINE rather than of the
 * workspace: they terminate processes, stop services, or kill whatever the
 * port manager thinks is orphaned. Those are the tools that can close an
 * unrelated application, so they need an authorization that a normal
 * read-only or workspace task does not have.
 *
 * This module decides authorization. It does NOT disable unattended
 * execution: the scheduler keeps firing, the daily brief keeps running,
 * reminders keep firing, and previously authorized Gmail/Calendar actions
 * keep working. What changes is only that a task with no human in the loop
 * cannot perform machine control, because nobody could approve it.
 *
 * Three rules, all derived from the task's own authorization:
 *
 *  1. A tool that is not machine control is untouched by this module.
 *  2. A tool that IS machine control requires an attended task (a human who
 *     can answer the approval card) OR an explicit machine-control
 *     authorization frozen into the task envelope.
 *  3. `port_cleanup_orphans` without `killOrphans` is reconciliation only
 *     (it drops stale records and terminates nothing), so it stays allowed
 *     everywhere.
 */

export const SCHEDULER_CLIENT_ID = 'core:scheduler';

/**
 * The client id every unattended, machine-fired attempt uses: the scheduler
 * (scheduled tasks, the daily brief, scout watches, follow-ups). No human is
 * watching when one of these runs.
 */
export function isUnattendedClientId(clientId: string | null | undefined): boolean {
  return clientId === SCHEDULER_CLIENT_ID;
}

export type MachineControlRisk =
  | 'arbitrary_process_termination'
  | 'foreign_service_control'
  | 'unsafe_port_cleanup'
  | 'scheduled_task_toggle';

/**
 * The machine-control surface. Every tool listed here can close an
 * application that Pandesh does not own, so it needs a stronger
 * authorization than "the model asked for it".
 */
export const MACHINE_CONTROL_TOOLS: Readonly<Record<string, MachineControlRisk>> = Object.freeze({
  system_kill_process: 'arbitrary_process_termination',
  system_stop_service: 'foreign_service_control',
  system_start_service: 'foreign_service_control',
  port_stop_service: 'foreign_service_control',
  port_cleanup_orphans: 'unsafe_port_cleanup',
  system_set_scheduled_task_enabled: 'scheduled_task_toggle',
});

export interface MachineControlAuthorizationInput {
  toolName: string;
  arguments?: Record<string, unknown>;
  /** True when no human can answer an approval for this attempt. */
  unattended: boolean;
  /** Explicit machine-control authorization frozen into the task envelope. */
  machineControlAuthorized?: boolean;
}

export interface MachineControlAuthorization {
  decision: 'allow' | 'deny';
  reason: string;
  risk?: MachineControlRisk;
}

const RISK_LABEL: Record<MachineControlRisk, string> = {
  arbitrary_process_termination: 'arbitrary process termination',
  foreign_service_control: 'service shutdown or startup',
  unsafe_port_cleanup: 'port cleanup that terminates processes',
  scheduled_task_toggle: 'enabling or disabling a scheduled task',
};

/** `port_cleanup_orphans` only terminates something when asked to. */
function terminatesProcesses(toolName: string, args: Record<string, unknown> | undefined): boolean {
  if (toolName === 'port_cleanup_orphans') return args?.killOrphans === true;
  return true;
}

export function evaluateMachineControlAuthorization(
  input: MachineControlAuthorizationInput,
): MachineControlAuthorization {
  const risk = MACHINE_CONTROL_TOOLS[input.toolName];
  if (!risk) {
    return { decision: 'allow', reason: 'not a machine-control tool' };
  }
  const label = RISK_LABEL[risk];
  const args = input.arguments ?? {};

  if (input.toolName === 'port_cleanup_orphans' && !terminatesProcesses(input.toolName, args)) {
    return {
      decision: 'allow',
      risk,
      reason: 'port reconciliation without process termination',
    };
  }

  // A process that could not be identified is never terminated. The adapter
  // records this while preparing the call; the refusal happens here, before
  // an approval card is created for a target nobody could name.
  if (args.targetIdentityUnavailable === true) {
    return {
      decision: 'deny',
      risk,
      reason:
        'the target process could not be identified, so it will not be terminated: ' +
        'a process whose identity cannot be read is never killed',
    };
  }

  if (input.machineControlAuthorized === true) {
    return {
      decision: 'allow',
      risk,
      reason: 'machine control was explicitly authorized for this task',
    };
  }

  if (input.unattended) {
    return {
      decision: 'deny',
      risk,
      reason:
        `${label} is not authorized for an unattended scheduled task: no person can approve it, ` +
        'so the action is refused instead of performed without a decision. Run it from a conversation, ' +
        'or have the operator authorize machine control for that task.',
    };
  }

  return {
    decision: 'allow',
    risk,
    reason: `${label} requires the operator's approval before it runs`,
  };
}

/** Convenience for callers that only need the risk class. */
export function machineControlRisk(toolName: string): MachineControlRisk | undefined {
  return MACHINE_CONTROL_TOOLS[toolName];
}
