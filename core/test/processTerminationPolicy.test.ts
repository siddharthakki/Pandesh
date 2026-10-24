import { describe, expect, it } from 'vitest';
import {
  evaluateMachineControlAuthorization,
  isUnattendedClientId,
  machineControlRisk,
  SCHEDULER_CLIENT_ID,
} from '../domain/processTerminationPolicy';

describe('Machine-control tool authorization', () => {
  it('does not touch tools that are not machine control', () => {
    const result = evaluateMachineControlAuthorization({
      toolName: 'gmail_search',
      arguments: { query: 'inbox' },
      unattended: true,
    });
    expect(result.decision).toBe('allow');
  });

  it('denies arbitrary process termination for an unattended scheduled task', () => {
    const result = evaluateMachineControlAuthorization({
      toolName: 'system_kill_process',
      arguments: { pid: 1234 },
      unattended: true,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('unattended');
    expect(result.risk).toBe('arbitrary_process_termination');
  });

  it('denies foreign service shutdown for an unattended scheduled task', () => {
    for (const toolName of ['system_stop_service', 'system_start_service', 'port_stop_service']) {
      const result = evaluateMachineControlAuthorization({
        toolName,
        arguments: { serviceName: 'Spooler' },
        unattended: true,
      });
      expect(result.decision).toBe('deny');
      expect(result.risk).toBe('foreign_service_control');
    }
  });

  it('denies unsafe port cleanup for an unattended scheduled task but allows record reconciliation', () => {
    const killing = evaluateMachineControlAuthorization({
      toolName: 'port_cleanup_orphans',
      arguments: { killOrphans: true },
      unattended: true,
    });
    expect(killing.decision).toBe('deny');
    expect(killing.risk).toBe('unsafe_port_cleanup');

    const reconciling = evaluateMachineControlAuthorization({
      toolName: 'port_cleanup_orphans',
      arguments: {},
      unattended: true,
    });
    expect(reconciling.decision).toBe('allow');
  });

  it('denies enabling or disabling a scheduled task for an unattended scheduled task', () => {
    const result = evaluateMachineControlAuthorization({
      toolName: 'system_set_scheduled_task_enabled',
      arguments: { taskName: 'DailyBrief', enabled: false },
      unattended: true,
    });
    expect(result.decision).toBe('deny');
    expect(result.risk).toBe('scheduled_task_toggle');
  });

  it('leaves an attended task to the ordinary human approval', () => {
    const result = evaluateMachineControlAuthorization({
      toolName: 'system_kill_process',
      arguments: { pid: 1234 },
      unattended: false,
    });
    expect(result.decision).toBe('allow');
    expect(result.reason).toContain('approval');
  });

  it('allows an unattended task when machine control was explicitly authorized', () => {
    const result = evaluateMachineControlAuthorization({
      toolName: 'system_kill_process',
      arguments: { pid: 1234 },
      unattended: true,
      machineControlAuthorized: true,
    });
    expect(result.decision).toBe('allow');
  });

  it('never terminates a process whose identity could not be read', () => {
    const result = evaluateMachineControlAuthorization({
      toolName: 'system_kill_process',
      arguments: { pid: 1234, targetIdentityUnavailable: true },
      unattended: false,
    });
    expect(result.decision).toBe('deny');
    expect(result.reason).toContain('could not be identified');
  });

  it('recognizes the scheduler as the unattended client', () => {
    expect(isUnattendedClientId(SCHEDULER_CLIENT_ID)).toBe(true);
    expect(isUnattendedClientId('desktop')).toBe(false);
    expect(isUnattendedClientId(undefined)).toBe(false);
  });

  it('exposes the risk class of every machine-control tool', () => {
    expect(machineControlRisk('system_kill_process')).toBe('arbitrary_process_termination');
    expect(machineControlRisk('system_stop_service')).toBe('foreign_service_control');
    expect(machineControlRisk('port_cleanup_orphans')).toBe('unsafe_port_cleanup');
    expect(machineControlRisk('read_file')).toBeUndefined();
  });
});
